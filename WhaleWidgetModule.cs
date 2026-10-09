using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Alife.Foundation;
using Alife.Framework;
using Alife.Function.FunctionCaller;
using Microsoft.Extensions.Logging;

namespace WhaleWidget;

public class WhaleWidgetConfig
{
    [DisplayName("启用挂件")]
    [Description("Alife 启动时自动拉起小鲸鱼挂件（悬浮窗 + 本地宿主服务）")]
    public bool Enabled { get; set; } = true;

    [DisplayName("宿主端口")]
    [Description("挂件本地服务监听的端口，被占用时会自动向后顺延")]
    public int Port { get; set; } = 54321;

    [DisplayName("挂件缩放")]
    [Description("挂件显示大小，1.0=标准，1.5=默认")]
    public double Scale { get; set; } = 1.5;

    [DisplayName("Node 路径")]
    [Description("运行宿主服务用的 node 可执行文件。留空则使用 PATH 中的 node（需要自行安装 Node.js 18+）")]
    public string NodePath { get; set; } = "";

    [DisplayName("Python 路径")]
    [Description("运行悬浮窗用的 python 可执行文件。留空则优先使用 Alife 运行时自带的 Python，其次使用 PATH 中的 python")]
    public string PythonPath { get; set; } = "";

    [DisplayName("宿主就绪超时（秒）")]
    [Description("启动后等待宿主服务就绪的最长时间，超时则不再打开窗口")]
    public int ReadyTimeoutSeconds { get; set; } = 30;
}

/// <summary>
/// 小鲸鱼记账挂件（移植自 DeepSeek-Balance-Whale-Widget，MIT）：
/// 宿主层为本地 Node 服务（复用原版插件的全部路由），前端层为 pywebview 悬浮窗。
/// 模块负责随 Alife 启停这两个子进程，并提供 AI 自助控制入口。
/// </summary>
[Module("小鲸鱼记账挂件",
    """
    桌面小鲸鱼挂件：显示 DeepSeek 余额、按轮次记账、支持拖拽吸附与点击互动。
    随 Alife 自动启停，可让 AI 主动启停或查询状态。
    """,
    defaultCategory: "智乃乃自制")]
public class WhaleWidgetModule(
    XmlFunctionCaller functionCaller,
    Interactor<WhaleWidgetModule> interactor,
    ILogger<WhaleWidgetModule> logger) :
    ChatBehaviour,
    IConfigurable<WhaleWidgetConfig>
{
    public WhaleWidgetConfig Configuration { get; set; } = null!;

    Process? serverProcess;
    Process? windowProcess;
    int actualPort;
    string hostDir = null!;
    readonly object sync = new();

    // ===== AI 自助调用 =====

    [XmlFunction(FunctionMode.OneShot)]
    [Description("重新启动桌面的小鲸鱼记账挂件（宿主服务 + 悬浮窗）")]
    public async Task RestartWhaleWidget()
    {
        await StopAsync();
        await StartAsync();
        interactor.Poke("小鲸鱼挂件已重新启动（端口 " + actualPort + "）");
    }

    [XmlFunction(FunctionMode.OneShot)]
    [Description("关闭桌面的小鲸鱼记账挂件（连同本地宿主服务一起停止）")]
    public async Task StopWhaleWidget()
    {
        await StopAsync();
        interactor.Poke("小鲸鱼挂件已关闭");
    }

    [XmlFunction(FunctionMode.OneShot)]
    [Description("查看小鲸鱼挂件的运行状态（宿主服务、悬浮窗是否在跑）")]
    public Task QueryWhaleWidget()
    {
        bool s, w;
        lock (sync)
        {
            s = serverProcess != null && serverProcess.HasExited == false;
            w = windowProcess != null && windowProcess.HasExited == false;
        }
        string text = s || w
            ? $"小鲸鱼挂件状态：宿主服务{(s ? "运行中" : "已停止")}，悬浮窗{(w ? "显示中" : "未显示")}，端口 {actualPort}"
            : "小鲸鱼挂件当前未运行";
        interactor.Poke(text);
        return Task.CompletedTask;
    }

    // ===== 生命周期 =====

    protected override Task OnAwake()
    {
        hostDir = Path.Combine(AlifePath.StorageFolderPath, "Plugins", "ZhinaiNai.WhaleWidget", "host");

        XmlHandler xmlHandler = new(this) {
            Description = "你的桌面小鲸鱼记账挂件（余额显示、按轮次记账、拖拽吸附），可以启停或查看状态。",
            Explanation = "挂件通常随 Alife 自动运行；如遇显示异常或需要临时隐藏，可主动调用这些入口。"
        };
        functionCaller.RegisterHandler(xmlHandler, DocumentMode.Implicit, DestroyCancellationToken);

        return Task.CompletedTask;
    }

    protected override Task OnStart()
    {
        if (Configuration.Enabled == false)
        {
            logger.LogInformation("小鲸鱼挂件：配置为不自动启动");
            return Task.CompletedTask;
        }

        if (Directory.Exists(hostDir) == false)
        {
            logger.LogWarning($"小鲸鱼挂件：宿主目录不存在（{hostDir}），跳过启动");
            return Task.CompletedTask;
        }

        _ = StartAsync();
        return Task.CompletedTask;
    }

    protected override async Task OnDestroy()
    {
        await StopAsync();
    }

    // ===== 启停实现 =====

    async Task StartAsync()
    {
        try
        {
            if (TryFindFreePort(Configuration.Port, out int port) == false)
            {
                logger.LogError($"小鲸鱼挂件：端口 {Configuration.Port} 起 20 个端口均被占用，启动失败");
                return;
            }
            actualPort = port;

            StartServer(port);
            if (await WaitForServerAsync(port, Configuration.ReadyTimeoutSeconds, DestroyCancellationToken) == false)
            {
                logger.LogError("小鲸鱼挂件：宿主服务未在预期时间内就绪，放弃打开窗口（请检查是否已安装 Node.js，以及日志中的 node 报错）");
                return;
            }

            StartWindow(port);
            logger.LogInformation($"小鲸鱼挂件已启动: http://127.0.0.1:{port}/");
        }
        catch (Exception e)
        {
            logger.LogError(e, "小鲸鱼挂件启动失败");
        }
    }

    async Task StopAsync()
    {
        Process? s, w;
        lock (sync)
        {
            s = serverProcess; w = windowProcess;
            serverProcess = null; windowProcess = null;
        }

        await KillAsync(w, "悬浮窗");
        await KillAsync(s, "宿主服务");
    }

    static async Task KillAsync(Process? process, string name)
    {
        if (process == null) return;
        try
        {
            if (process.HasExited == false)
            {
                process.Kill(entireProcessTree: true);
                using CancellationTokenSource cts = new(TimeSpan.FromSeconds(5));
                await process.WaitForExitAsync(cts.Token);
            }
        }
        catch { }
        finally
        {
            try { process.Dispose(); } catch { }
        }
    }

    /// <summary>把与原版共用的运行参数通过环境变量传给宿主，避免任何机器相关路径写死在脚本里。</summary>
    void ApplyCommonEnvironment(ProcessStartInfo startInfo)
    {
        startInfo.Environment["WHALE_SRC"] = Path.Combine(hostDir, "..", "upstream");
        startInfo.Environment["WHALE_HOME"] = Path.Combine(AlifePath.StorageFolderPath, "WhaleWidget");
        startInfo.Environment["WHALE_USAGE_LOG"] = Path.Combine(AlifePath.StorageFolderPath, "Tokenlog", "usage-log.jsonl");
        startInfo.Environment["WHALE_PRICING"] = Path.Combine(AlifePath.StorageFolderPath, "Tokenlog", "pricing.json");
    }

    void StartServer(int port)
    {
        string nodeExe = string.IsNullOrWhiteSpace(Configuration.NodePath) ? "node" : Configuration.NodePath;
        ProcessStartInfo startInfo = new() {
            FileName = nodeExe,
            Arguments = "\"server.mjs\"",
            WorkingDirectory = hostDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.Environment["WHALE_PORT"] = port.ToString();
        ApplyCommonEnvironment(startInfo);

        Process process = new() { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) logger.LogInformation("[whale-host] " + e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) logger.LogWarning("[whale-host] " + e.Data); };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        lock (sync) { serverProcess = process; }
    }

    void StartWindow(int port)
    {
        string python = ResolvePython();
        if (python.Length == 0)
        {
            logger.LogWarning("小鲸鱼挂件：找不到可用的 python 解释器，跳过悬浮窗");
            return;
        }

        ProcessStartInfo startInfo = new() {
            FileName = python,
            Arguments = $"\"window.py\" \"http://127.0.0.1:{port}/\" {Configuration.Scale.ToString(System.Globalization.CultureInfo.InvariantCulture)}",
            WorkingDirectory = hostDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            StandardOutputEncoding = Encoding.UTF8,
            StandardErrorEncoding = Encoding.UTF8,
        };
        startInfo.Environment["PYTHONIOENCODING"] = "utf-8";
        startInfo.Environment["PYTHONUTF8"] = "1";
        ApplyCommonEnvironment(startInfo);

        Process process = new() { StartInfo = startInfo, EnableRaisingEvents = true };
        process.OutputDataReceived += (_, e) => { if (e.Data != null) logger.LogInformation("[whale-window] " + e.Data); };
        process.ErrorDataReceived += (_, e) => { if (e.Data != null) logger.LogWarning("[whale-window] " + e.Data); };
        process.Start();
        process.BeginOutputReadLine();
        process.BeginErrorReadLine();

        lock (sync) { windowProcess = process; }
    }

    string ResolvePython()
    {
        if (string.IsNullOrWhiteSpace(Configuration.PythonPath) == false && File.Exists(Configuration.PythonPath))
            return Configuration.PythonPath;

        string runtime = Path.Combine(AlifePath.RuntimeFolderPath, "Python312", "python.exe");
        if (File.Exists(runtime)) return runtime;

        return "python";
    }

    static bool TryFindFreePort(int startPort, out int port)
    {
        for (int attempt = 0; attempt < 20; attempt++)
        {
            int candidate = Math.Clamp(startPort + attempt, 1, 65535);
            TcpListener? listener = null;
            try
            {
                listener = new TcpListener(IPAddress.Loopback, candidate);
                listener.Start();
                port = candidate;
                return true;
            }
            catch { }
            finally
            {
                try { listener?.Stop(); } catch { }
            }
        }
        port = 0;
        return false;
    }

    static async Task<bool> WaitForServerAsync(int port, int timeoutSeconds, CancellationToken cancellationToken)
    {
        DateTime deadline = DateTime.Now.AddSeconds(Math.Max(3, timeoutSeconds));
        while (DateTime.Now < deadline && cancellationToken.IsCancellationRequested == false)
        {
            try
            {
                using TcpClient client = new();
                using CancellationTokenSource cts = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
                cts.CancelAfter(TimeSpan.FromSeconds(1));
                await client.ConnectAsync(IPAddress.Loopback, port, cts.Token);
                return true;
            }
            catch
            {
                await Task.Delay(500, cancellationToken).ContinueWith(_ => { });
            }
        }
        return false;
    }
}