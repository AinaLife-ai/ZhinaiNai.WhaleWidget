# -*- coding: utf-8 -*-
# 小鲸鱼挂件 —— Alife 悬浮窗壳
#
# 透明方案：窗体 BackColor=Black + DwmExtendFrameIntoClientArea(-1)（纯黑区域在 DWM
#           合成时完全透明，且鼠标事件照常命中）。注意 pywebview 自带的
#           `transparent=True` 只把 WebView2 的背景设为透明，下层 WinForms 窗体底色
#           （默认 #F0F0F0 浅灰）照样显示 —— 屏幕上会是一块灰板，所以必须自己补 DWM 玻璃。
#           备选方案 LWA_COLORKEY 无效（WebView2 不吃色键），TransparencyKey 虽能透明
#           但会让该色区域整窗 hit-test 穿透（点不动、拖不动），均已排除。
# 区域方案：窗口保持足够大（弹窗能完整显示），但用 SetWindowRgn 只把「挂件本体 + 可见浮层」
#           那块设成窗口区域 —— 其余透明区直接穿透到桌面，既不误拖也不挡点击。
import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes

import webview

URL = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:54321/"
SCALE = float(sys.argv[2]) if len(sys.argv) > 2 else 1.5

# 挂件本体 = min(250*scale, 625)；窗口给它 + 菜单/气泡/弹窗的余量
BASE = min(250 * SCALE, 625)
W = int(BASE + 300)
H = int(BASE + 300)

window = webview.create_window(
    "小鲸鱼",
    URL,
    width=W,
    height=H,
    frameless=True,
    easy_drag=True,      # 拖拽保留：抓住挂件本体即可拖动整窗
    on_top=True,
    transparent=True,
    resizable=False,
)

_hwnd = None
_last_key = None


class _RECT(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


class _MARGINS(ctypes.Structure):
    _fields_ = [("cxLeftWidth", ctypes.c_int), ("cxRightWidth", ctypes.c_int),
                ("cyTopHeight", ctypes.c_int), ("cyBottomHeight", ctypes.c_int)]


def set_black_background():
    """把窗体底色改成纯黑 —— 配合 DWM 玻璃，黑色区域在合成时完全透明。
    优先走 pywebview 暴露的 WinForms 窗体对象；拿不到时退化为设置窗口类背景画刷。"""
    try:
        native = getattr(window, "native", None)
        if native is not None:
            import System.Drawing
            native.BackColor = System.Drawing.Color.Black
            print("[dwm] 窗体底色已设为黑（WinForms 对象）", flush=True)
            return True
    except Exception as e:
        print("[dwm] WinForms 对象不可用:", e, flush=True)
    try:
        GCLP_HBRBACKGROUND = -10
        gdi32 = ctypes.windll.gdi32
        user32 = ctypes.windll.user32
        brush = gdi32.CreateSolidBrush(0x000000)
        if brush:
            user32.SetClassLongPtrW(int(_hwnd), GCLP_HBRBACKGROUND, brush)
            print("[dwm] 窗口类背景画刷已设为黑", flush=True)
            return True
    except Exception as e:
        print("[dwm] 背景画刷设置失败:", e, flush=True)
    return False


def apply_dwm_glass(hwnd):
    """把窗体底色的黑色区域变成真透明（DWM 玻璃补丁）。
    pywebview 的 transparent=True 只处理 WebView2 一侧，WinForms 窗体底色仍是不透明浅灰，
    不补这一步屏幕上会多出一块灰板。"""
    try:
        hwnd = int(hwnd)
        ctypes.windll.dwmapi.DwmExtendFrameIntoClientArea(
            hwnd, ctypes.byref(_MARGINS(-1, -1, -1, -1)))
        return True
    except Exception as e:
        print("[dwm] err:", e, flush=True)
        return False


def clamp_to_screen(hwnd):
    """把窗口位置夹回屏幕内。
    窗口被拖到屏幕外时，向上展开的浮层会跑到屏幕外，表现为「拖到顶端弹窗显示不全」。
    窗口整体留在屏幕内即可根治。"""
    try:
        user32 = ctypes.windll.user32
        sw = user32.GetSystemMetrics(0)
        sh = user32.GetSystemMetrics(1)
        r = _RECT()
        if not user32.GetWindowRect(hwnd, ctypes.byref(r)):
            return False
        x, y = r.left, r.top
        w = max(1, r.right - r.left)
        h = max(1, r.bottom - r.top)
        nx, ny = x, y
        if x < 0:
            nx = 0
        if y < 0:
            ny = 0
        if x + w > sw:
            nx = max(0, sw - w)
        if y + h > sh:
            ny = max(0, sh - h)
        if (nx, ny) != (x, y):
            SWP_NOSIZE = 0x0001
            SWP_NOZORDER = 0x0004
            SWP_NOACTIVATE = 0x0010
            user32.SetWindowPos(hwnd, 0, nx, ny, 0, 0,
                                SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE)
            return True
    except Exception as e:
        print("[clamp] err:", e, flush=True)
    return False


def _apply_region(hwnd, box, free):
    """box=None 或 free=True → 取消裁剪；否则把窗口区域限制为 box(CSS 像素)。"""
    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    try:
        if free or not box:
            user32.SetWindowRgn(hwnd, 0, True)
            return "free"
        dpr = float(box.get("dpr") or 1)
        pad = 2
        x = int(box["x"] * dpr) - pad
        y = int(box["y"] * dpr) - pad
        w = int(box["w"] * dpr) + pad * 2
        h = int(box["h"] * dpr) + pad * 2
        rgn = gdi32.CreateRectRgn(x, y, x + w, y + h)
        if user32.SetWindowRgn(hwnd, rgn, True):
            return "rgn %d,%d %dx%d" % (x, y, w, h)   # 成功后 rgn 归系统所有
        gdi32.DeleteObject(rgn)
        return "rgn fail"
    except Exception as e:
        print("apply_region err:", e, flush=True)
        return "err"


PROBE_JS = r"""(function(){
  try {
    var root = document.querySelector('.dshwv-root');
    if (!root) return '';
    function vis(e){
      if (!e) return false;
      var st = getComputedStyle(e);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity || 1) <= 0.01) return false;
      return true;
    }
    // 区域 = 挂件本体 ∪ 所有可见浮层的并集。
    // 原版的菜单/气泡/各种遮罩面板都挂在 body 上（不在 .dshwv-root 里），
    // 只按 root 裁剪会把它们切掉。
    var boxes = [];
    var r0 = root.getBoundingClientRect();
    if (r0.width > 0 && r0.height > 0) boxes.push(r0);
    var kids = document.body.children;
    for (var i = 0; i < kids.length; i++) {
      var e = kids[i];
      if (e === root) continue;
      var tg = e.tagName;
      if (tg === 'SCRIPT' || tg === 'STYLE' || tg === 'LINK') continue;
      var cls = String(e.className || '');
      if (cls.indexOf('dshwv') < 0) continue;
      if (!vis(e)) continue;
      var rr = e.getBoundingClientRect();
      if (rr.width > 0 && rr.height > 0) boxes.push(rr);
    }
    if (!boxes.length) return '';
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (var b = 0; b < boxes.length; b++) {
      var q = boxes[b];
      if (q.left < x0) x0 = q.left;
      if (q.top < y0) y0 = q.top;
      if (q.right > x1) x1 = q.right;
      if (q.bottom > y1) y1 = q.bottom;
    }
    return JSON.stringify({
      x: Math.round(x0), y: Math.round(y0),
      w: Math.round(x1 - x0), h: Math.round(y1 - y0),
      dpr: window.devicePixelRatio || 1,
      vw: window.innerWidth, vh: window.innerHeight,
      n: boxes.length
    });
  } catch (err) { return ''; }
})()"""


def find_hwnd():
    user32 = ctypes.windll.user32
    found = []

    def cb(h, l):
        if user32.IsWindowVisible(h):
            n = user32.GetWindowTextLengthW(h)
            if n:
                b = ctypes.create_unicode_buffer(n + 1)
                user32.GetWindowTextW(h, b, n + 1)
                if b.value == "小鲸鱼":
                    found.append(h)
        return True

    WNDENUMPROC = ctypes.WINFUNCTYPE(ctypes.c_bool, wintypes.HWND, wintypes.LPARAM)
    user32.EnumWindows(WNDENUMPROC(cb), 0)
    return found[0] if found else None


def watch_region():
    """定时问页面：挂件在哪 / 有没有弹窗，据此收放窗口形状。"""
    global _hwnd, _last_key
    time.sleep(5.0)
    while True:
        try:
            if _hwnd:
                clamp_to_screen(_hwnd)
                raw = window.evaluate_js(PROBE_JS)
                if raw:
                    d = json.loads(raw)
                    free = False
                    key = (round(d["x"]), round(d["y"]), round(d["w"]), round(d["h"]), d.get("n", 0))
                    if key != _last_key:
                        res = _apply_region(_hwnd, d, free)
                        _last_key = key
                        print("[region]", res, key, flush=True)
        except Exception as e:
            print("[region] err:", e, flush=True)
        time.sleep(0.25)


def setup():
    global _hwnd
    time.sleep(2.0)
    user32 = ctypes.windll.user32
    sw = user32.GetSystemMetrics(0)
    sh = user32.GetSystemMetrics(1)
    try:
        window.move(sw - W - 10, sh - H - 60)
        print("moved to", sw - W - 10, sh - H - 60, flush=True)
    except Exception as e:
        print("move failed:", e, flush=True)
    time.sleep(1.0)
    hwnd = find_hwnd()
    if hwnd:
        _hwnd = hwnd
        print("hwnd:", hwnd, flush=True)
        # 透明：窗体底色改黑 + DWM 玻璃（缺一不可）
        set_black_background()
        apply_dwm_glass(hwnd)
        # 这里只补桌面挂件的窗口特性
        GWL_EXSTYLE = -20
        ex = user32.GetWindowLongW(hwnd, GWL_EXSTYLE)
        # WS_EX_TOOLWINDOW：不在任务栏/Alt+Tab 里露脸
        ex = (ex | 0x00000080) & ~0x00040000
        user32.SetWindowLongW(hwnd, GWL_EXSTYLE, ex)
        print("exstyle -> 0x%08X (已隐藏任务栏图标)" % ex, flush=True)
        threading.Thread(target=watch_region, daemon=True).start()
    else:
        print("没找到窗口句柄", flush=True)


threading.Thread(target=setup, daemon=True).start()
webview.start(debug=False, gui="edgechromium")