use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// 角色热区（相对窗口的逻辑坐标）。鼠标在这个矩形内时窗口可交互，否则整窗穿透。
struct HitRegion(Mutex<(f64, f64, f64, f64)>);

#[derive(Clone, serde::Serialize)]
struct CursorInfo {
    x: f64,
    y: f64,
    inside: bool,
}

static CURSOR_X: AtomicI32 = AtomicI32::new(0);
static CURSOR_Y: AtomicI32 = AtomicI32::new(0);
static INSIDE: AtomicBool = AtomicBool::new(false);
static LAST_POS_SAVE: AtomicU64 = AtomicU64::new(0);

#[cfg(windows)]
fn raw_cursor_pos() -> (i32, i32) {
    use windows_sys::Win32::Foundation::POINT;
    use windows_sys::Win32::UI::WindowsAndMessaging::GetCursorPos;
    let mut p = POINT { x: 0, y: 0 };
    // SAFETY: GetCursorPos 只写入栈上的 POINT，失败时返回 0 且 p 保持零值
    unsafe {
        GetCursorPos(&mut p);
    }
    (p.x, p.y)
}

#[cfg(not(windows))]
fn raw_cursor_pos() -> (i32, i32) {
    (0, 0)
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn window_pos_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("window.json"))
}

fn load_window_pos(app: &tauri::AppHandle) -> Option<(i32, i32)> {
    let path = window_pos_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    let v: serde_json::Value = serde_json::from_str(&raw).ok()?;
    Some((v.get("x")?.as_i64()? as i32, v.get("y")?.as_i64()? as i32))
}

fn save_window_pos(app: &tauri::AppHandle, x: i32, y: i32) {
    if let Some(path) = window_pos_path(app) {
        if let Some(dir) = path.parent() {
            let _ = std::fs::create_dir_all(dir);
        }
        let _ = std::fs::write(path, serde_json::json!({ "x": x, "y": y }).to_string());
    }
}

/// 恢复的位置可能落在已经拔掉的显示器上，先校验再采用。
fn pos_on_screen(win: &tauri::WebviewWindow, x: i32, y: i32) -> bool {
    let Ok(monitors) = win.available_monitors() else {
        return false;
    };
    monitors.iter().any(|m| {
        let p = m.position();
        let s = m.size();
        let (w, h) = (s.width as i32, s.height as i32);
        x >= p.x - 60 && x + 120 <= p.x + w && y >= p.y - 20 && y + 120 <= p.y + h
    })
}

fn toggle_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(win) = app.get_webview_window("main") {
        if win.is_visible().unwrap_or(false) {
            let _ = win.hide();
        } else {
            let _ = win.show();
            let _ = win.set_focus();
        }
    }
}

#[tauri::command]
fn cursor_info() -> CursorInfo {
    CursorInfo {
        x: CURSOR_X.load(Ordering::Relaxed) as f64,
        y: CURSOR_Y.load(Ordering::Relaxed) as f64,
        inside: INSIDE.load(Ordering::Relaxed),
    }
}

#[tauri::command]
fn set_hit_region(region: tauri::State<'_, HitRegion>, x: f64, y: f64, w: f64, h: f64) {
    if let Ok(mut r) = region.0.lock() {
        *r = (x, y, w, h);
    }
}

#[tauri::command]
fn set_click_through(window: tauri::Window, ignore: bool) -> Result<(), String> {
    window
        .set_ignore_cursor_events(ignore)
        .map_err(|e| e.to_string())
}

#[tauri::command]
fn hide_window(window: tauri::Window) -> Result<(), String> {
    window.hide().map_err(|e| e.to_string())
}

/// 从本机的 AI CLI 配置里捞可用的接口信息，省得手抄 key。
/// 依次尝试：opencode auth.json → mimocode → deepseek CLI。
#[tauri::command]
fn import_cli_config() -> Result<serde_json::Value, String> {
    let home = std::env::var("USERPROFILE").map_err(|e| e.to_string())?;
    let home = PathBuf::from(home);

    // 1) opencode CLI：auth.json 里的 opencode-go key
    let oc_auth = home
        .join(".local")
        .join("share")
        .join("opencode")
        .join("auth.json");
    if let Ok(raw) = std::fs::read_to_string(&oc_auth) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(key) = v
                .get("opencode-go")
                .and_then(|x| x.get("key"))
                .and_then(|x| x.as_str())
            {
                return Ok(serde_json::json!({
                    "endpoint": "https://opencode.ai/zen/go/v1",
                    "apiKey": key,
                    "model": "deepseek-v4.1-flash",
                    "source": "opencode",
                }));
            }
        }
    }

    // 2) mimocode：provider.opencode.options
    let mimo = home.join(".config").join("mimocode").join("mimocode.jsonc");
    if let Ok(raw) = std::fs::read_to_string(&mimo) {
        if let Ok(v) = serde_json::from_str::<serde_json::Value>(&raw) {
            if let Some(opts) = v
                .get("provider")
                .and_then(|x| x.get("opencode"))
                .and_then(|x| x.get("options"))
            {
                let key = opts.get("apiKey").and_then(|x| x.as_str()).unwrap_or("");
                let base = opts
                    .get("baseURL")
                    .and_then(|x| x.as_str())
                    .unwrap_or("https://opencode.ai/zen/go/v1");
                if !key.is_empty() {
                    return Ok(serde_json::json!({
                        "endpoint": base,
                        "apiKey": key,
                        "model": "deepseek-v4.1-flash",
                        "source": "mimocode",
                    }));
                }
            }
        }
    }

    // 3) deepseek CLI：api_key + default_text_model
    let ds = home.join(".deepseek").join("config.toml");
    if let Ok(content) = std::fs::read_to_string(&ds) {
        let mut api_key = String::new();
        let mut base_url = String::new();
        let mut model = String::new();
        for line in content.lines() {
            let line = line.trim();
            if line.starts_with('#') {
                continue;
            }
            let Some((k, v)) = line.split_once('=') else {
                continue;
            };
            let v = v.trim().trim_matches('"');
            match k.trim() {
                "api_key" if !v.is_empty() => api_key = v.to_string(),
                "base_url" if !v.is_empty() => base_url = v.to_string(),
                "default_text_model" if !v.is_empty() => model = v.to_string(),
                _ => {}
            }
        }
        if !api_key.is_empty() {
            let endpoint = if base_url.is_empty() {
                "https://api.deepseek.com/v1".to_string()
            } else if base_url.ends_with("/v1") {
                base_url
            } else {
                format!("{}/v1", base_url.trim_end_matches('/'))
            };
            return Ok(serde_json::json!({
                "endpoint": endpoint,
                "apiKey": api_key,
                "model": if model.is_empty() { "deepseek-chat".to_string() } else { model },
                "source": "deepseek-cli",
            }));
        }
    }

    Err("没找到可导入的配置".into())
}


// ---------- B 站浏览 ----------

#[derive(serde::Serialize, Clone)]
struct BiliVideo {
    bvid: String,
    aid: i64,
    title: String,
    owner: String,
    tname: String,
    desc: String,
    view: i64,
    danmaku: i64,
    reply: i64,
    duration: i64,
    cid: i64,
}

#[derive(serde::Serialize, Clone)]
struct BiliComment {
    user: String,
    message: String,
    like: i64,
    /// 发评论的人 uid，用来判断这条是不是她自己发的
    mid: i64,
    rpid: i64,
}

fn bili_client() -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .user_agent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 \
             (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        )
        .timeout(Duration::from_secs(20))
        .build()
        .map_err(|e| e.to_string())
}

fn take_str(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|x| x.as_str()).unwrap_or("").to_string()
}

fn take_i64(v: &serde_json::Value, key: &str) -> i64 {
    v.get(key).and_then(|x| x.as_i64()).unwrap_or(0)
}

fn parse_video(v: &serde_json::Value) -> BiliVideo {
    let stat = v.get("stat").cloned().unwrap_or(serde_json::Value::Null);
    BiliVideo {
        bvid: take_str(v, "bvid"),
        aid: take_i64(v, "aid"),
        title: take_str(v, "title"),
        owner: v
            .get("owner")
            .map(|o| take_str(o, "name"))
            .unwrap_or_default(),
        tname: take_str(v, "tname"),
        desc: take_str(v, "desc"),
        view: take_i64(&stat, "view"),
        danmaku: take_i64(&stat, "danmaku"),
        reply: take_i64(&stat, "reply"),
        duration: take_i64(v, "duration"),
        cid: v
            .get("cid")
            .and_then(|x| x.as_i64())
            .or_else(|| {
                v.get("pages")
                    .and_then(|p| p.get(0))
                    .and_then(|p| p.get("cid"))
                    .and_then(|x| x.as_i64())
            })
            .unwrap_or(0),
    }
}

/// 全站热门。她"逛 B 站"的入口，不需要登录。
#[tauri::command]
async fn bili_popular(ps: Option<u32>) -> Result<Vec<BiliVideo>, String> {
    let ps = ps.unwrap_or(10).clamp(1, 30);
    let url = format!("https://api.bilibili.com/x/web-interface/popular?ps={ps}&pn=1");
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let code = take_i64(&resp, "code");
    if code != 0 {
        return Err(format!("B站返回 code={code}"));
    }
    let list = resp
        .get("data")
        .and_then(|d| d.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list.iter().map(parse_video).collect())
}

/// 分区排行榜。她按自己的兴趣分区逛，而不是只看全站热门。
#[tauri::command]
async fn bili_ranking(rid: i32, ps: Option<u32>) -> Result<Vec<BiliVideo>, String> {
    let ps = ps.unwrap_or(10).clamp(1, 50) as usize;
    let url = format!("https://api.bilibili.com/x/web-interface/ranking/v2?rid={rid}&type=all");
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Err(format!("排行榜 code={}", take_i64(&resp, "code")));
    }
    let list = resp
        .get("data")
        .and_then(|d| d.get("list"))
        .and_then(|l| l.as_array())
        .cloned()
        .unwrap_or_default();
    Ok(list.iter().take(ps).map(parse_video).collect())
}

/// 单个视频详情。
#[tauri::command]
async fn bili_video(bvid: String) -> Result<BiliVideo, String> {
    let url = format!("https://api.bilibili.com/x/web-interface/view?bvid={bvid}");
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Err(format!("取视频失败 code={}", take_i64(&resp, "code")));
    }
    Ok(parse_video(resp.get("data").unwrap_or(&serde_json::Value::Null)))
}

/// 热门评论，排序按热度。用来让她"看看别人在聊什么"。
#[tauri::command]
async fn bili_comments(aid: i64, ps: Option<u32>) -> Result<Vec<BiliComment>, String> {
    let ps = ps.unwrap_or(5).clamp(1, 20);
    let url = format!("https://api.bilibili.com/x/v2/reply?type=1&oid={aid}&sort=2&ps={ps}&pn=1");
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let replies = resp
        .get("data")
        .and_then(|d| d.get("replies"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(replies
        .iter()
        .map(|r| BiliComment {
            user: r
                .get("member")
                .map(|m| take_str(m, "uname"))
                .unwrap_or_default(),
            message: r
                .get("content")
                .map(|c| take_str(c, "message"))
                .unwrap_or_default()
                .replace('\n', " "),
            like: take_i64(r, "like"),
            mid: r
                .get("member")
                .map(|m| take_i64(m, "mid"))
                .unwrap_or(0),
            rpid: take_i64(r, "rpid"),
        })
        .collect())
}


// ---------- B 站登录与评论 ----------

#[derive(serde::Serialize, serde::Deserialize, Default, Clone)]
struct BiliCookie {
    sessdata: String,
    bili_jct: String,
    buvid3: String,
    dedeuserid: String,
}

fn bili_cookie_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().app_data_dir().ok().map(|d| d.join("bili_cookie.json"))
}

fn load_bili_cookie(app: &tauri::AppHandle) -> Option<BiliCookie> {
    let path = bili_cookie_path(app)?;
    let raw = std::fs::read_to_string(path).ok()?;
    serde_json::from_str::<BiliCookie>(&raw).ok()
}

fn save_bili_cookie(app: &tauri::AppHandle, c: &BiliCookie) -> Result<(), String> {
    let path = bili_cookie_path(app).ok_or("拿不到数据目录")?;
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    let body = serde_json::to_string(c).map_err(|e| e.to_string())?;
    std::fs::write(path, body).map_err(|e| e.to_string())
}

fn cookie_value(set_cookie: &[String], name: &str) -> Option<String> {
    for raw in set_cookie {
        for part in raw.split(';') {
            let part = part.trim();
            if let Some(v) = part.strip_prefix(&format!("{name}=")) {
                if !v.is_empty() {
                    return Some(v.to_string());
                }
            }
        }
    }
    None
}

/// 生成登录二维码。前端拿 url 自己画二维码，不用后端出图。
#[tauri::command]
async fn bili_login_qr() -> Result<serde_json::Value, String> {
    let resp = bili_client()?
        .get("https://passport.bilibili.com/x/passport-login/web/qrcode/generate")
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Err("生成二维码失败".into());
    }
    let data = resp.get("data").cloned().unwrap_or(serde_json::Value::Null);
    Ok(serde_json::json!({
        "qrcodeKey": take_str(&data, "qrcode_key"),
        "url": take_str(&data, "url"),
    }))
}

/// 轮询扫码状态。成功时把 SESSDATA / bili_jct 存到本地。
#[tauri::command]
async fn bili_login_poll(app: tauri::AppHandle, qrcode_key: String) -> Result<serde_json::Value, String> {
    let url = format!(
        "https://passport.bilibili.com/x/passport-login/web/qrcode/poll?qrcode_key={qrcode_key}"
    );
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?;

    let set_cookies: Vec<String> = resp
        .headers()
        .get_all("set-cookie")
        .iter()
        .filter_map(|v| v.to_str().ok().map(|s| s.to_string()))
        .collect();

    let body = resp
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;
    let data = body.get("data").cloned().unwrap_or(serde_json::Value::Null);
    let state = take_i64(&data, "code");

    // 0 = 登录成功；86101 未扫码；86090 已扫码待确认；86038 已过期
    if state == 0 {
        let sessdata = cookie_value(&set_cookies, "SESSDATA").unwrap_or_default();
        let bili_jct = cookie_value(&set_cookies, "bili_jct").unwrap_or_default();
        let buvid3 = cookie_value(&set_cookies, "buvid3").unwrap_or_default();
        let dedeuserid = cookie_value(&set_cookies, "DedeUserID").unwrap_or_default();

        if sessdata.is_empty() || bili_jct.is_empty() {
            return Err("登录成功但没拿到凭证，浏览器可能拦截了 cookie".into());
        }

        let cookie = BiliCookie {
            sessdata,
            bili_jct,
            buvid3,
            dedeuserid,
        };
        save_bili_cookie(&app, &cookie)?;
        return Ok(serde_json::json!({ "status": "success", "uid": cookie.dedeuserid }));
    }

    let status = match state {
        86101 => "waiting",
        86090 => "scanned",
        86038 => "expired",
        _ => "unknown",
    };
    Ok(serde_json::json!({ "status": status }))
}

#[tauri::command]
fn bili_auth_status(app: tauri::AppHandle) -> serde_json::Value {
    match load_bili_cookie(&app) {
        Some(c) if !c.sessdata.is_empty() && !c.bili_jct.is_empty() => {
            serde_json::json!({ "loggedIn": true, "uid": c.dedeuserid })
        }
        _ => serde_json::json!({ "loggedIn": false, "uid": "" }),
    }
}

#[tauri::command]
fn bili_logout(app: tauri::AppHandle) -> Result<(), String> {
    if let Some(path) = bili_cookie_path(&app) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

/// 复核刚发的评论是否真的公开可见。
/// 接口回"发送成功"不等于公开可见——新号或风控会让评论进审核，别人看不到也收不到通知。
/// 查不到时只能结论为"没查到"，不能断言"没发出去"（翻页和排序都会漏）。
#[tauri::command]
async fn bili_check_reply(app: tauri::AppHandle, aid: i64, rpid: i64) -> Result<serde_json::Value, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let url = format!(
        "https://api.bilibili.com/x/v2/reply/main?type=1&oid={aid}&mode=2&next=0&ps=20"
    );
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Ok(serde_json::json!({ "visible": serde_json::Value::Null, "note": "查询失败" }));
    }

    let found = resp
        .get("data")
        .and_then(|d| d.get("replies"))
        .and_then(|r| r.as_array())
        .map(|arr| {
            arr.iter()
                .any(|r| r.get("rpid").and_then(|x| x.as_i64()) == Some(rpid))
        })
        .unwrap_or(false);

    if found {
        Ok(serde_json::json!({ "visible": true, "note": "最新一页可见" }))
    } else {
        Ok(serde_json::json!({
            "visible": serde_json::Value::Null,
            "note": "最新一页没查到，可能还在审核，也可能只是翻页看不到"
        }))
    }
}

/// 删掉自己刚发的评论。测试 @ 是否生效时用来撤回。
#[tauri::command]
async fn bili_del_comment(app: tauri::AppHandle, aid: i64, rpid: i64) -> Result<serde_json::Value, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let form = [
        ("oid", aid.to_string()),
        ("type", "1".to_string()),
        ("rpid", rpid.to_string()),
        ("csrf", cookie.bili_jct.clone()),
    ];
    let resp = bili_client()?
        .post("https://api.bilibili.com/x/v2/reply/del")
        .header("Referer", "https://www.bilibili.com")
        .header("Origin", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let code = take_i64(&resp, "code");
    Ok(serde_json::json!({ "ok": code == 0, "code": code, "message": take_str(&resp, "message") }))
}

/// 发一条评论。需要已登录，csrf 就是 bili_jct。
#[tauri::command]
async fn bili_reply(app: tauri::AppHandle, aid: i64, message: String) -> Result<serde_json::Value, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("评论内容为空".into());
    }
    if msg.chars().count() > 200 {
        return Err("评论太长".into());
    }

    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let form = [
        ("oid", aid.to_string()),
        ("type", "1".to_string()),
        ("message", msg.to_string()),
        ("csrf", cookie.bili_jct.clone()),
        ("plat", "1".to_string()),
    ];

    let resp = bili_client()?
        .post("https://api.bilibili.com/x/v2/reply/add")
        .header("Referer", "https://www.bilibili.com")
        .header("Origin", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let code = take_i64(&resp, "code");
    if code == 0 {
        // content.members 是服务端解析出来的 @ 列表，用来确认真的 @ 到人了
        let members = resp
            .get("data")
            .and_then(|d| d.get("reply"))
            .and_then(|r| r.get("content"))
            .and_then(|c| c.get("members"))
            .and_then(|m| m.as_array())
            .map(|arr| {
                arr.iter()
                    .map(|m| take_str(m, "uname"))
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let rpid = resp
            .get("data")
            .and_then(|d| d.get("rpid"))
            .and_then(|r| r.as_i64())
            .unwrap_or(0);
        Ok(serde_json::json!({ "ok": true, "members": members, "rpid": rpid }))
    } else {
        Ok(serde_json::json!({
            "ok": false,
            "code": code,
            "message": take_str(&resp, "message"),
        }))
    }
}


/// 拉第一段弹幕。弹幕不用登录，是"观众在看什么、笑什么"最直接的信号。
#[tauri::command]
async fn bili_danmaku(cid: i64) -> Result<Vec<String>, String> {
    if cid <= 0 {
        return Ok(vec![]);
    }
    let url = format!("https://api.bilibili.com/x/v1/dm/list.so?oid={cid}");
    let bytes = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;

    // B 站返回的是 raw deflate 压缩的 XML
    let xml = {
        use std::io::Read;
        let mut d = flate2::read::DeflateDecoder::new(&bytes[..]);
        let mut out = String::new();
        match d.read_to_string(&mut out) {
            Ok(_) if out.contains("<d ") => out,
            _ => String::from_utf8_lossy(&bytes).to_string(),
        }
    };

    let mut picked: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut rest = xml.as_str();

    while let Some(start) = rest.find("<d ") {
        let after = &rest[start..];
        let Some(gt) = after.find('>') else { break };
        let Some(end) = after[gt..].find("</d>") else { break };
        let content = &after[gt + 1..gt + end];
        rest = &after[gt + end + 4..];

        let text = content.trim();
        let len = text.chars().count();
        if len < 4 || len > 32 {
            continue;
        }
        if !seen.insert(text.to_string()) {
            continue;
        }
        picked.push(text.to_string());
        if picked.len() >= 40 {
            break;
        }
    }
    Ok(picked)
}

/// 拉视频字幕全文。需要登录（未登录时 B 站不返回字幕列表）。
#[tauri::command]
async fn bili_subtitle(app: tauri::AppHandle, aid: i64, cid: i64) -> Result<Option<String>, String> {
    if cid <= 0 {
        return Ok(None);
    }
    let cookie = load_bili_cookie(&app).unwrap_or_default();
    let cookie_header = if cookie.sessdata.is_empty() {
        String::new()
    } else {
        format!(
            "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
            cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
        )
    };

    let mut req = bili_client()?
        .get(format!("https://api.bilibili.com/x/player/v2?aid={aid}&cid={cid}"))
        .header("Referer", "https://www.bilibili.com");
    if !cookie_header.is_empty() {
        req = req.header("Cookie", cookie_header);
    }

    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let subs = resp
        .get("data")
        .and_then(|d| d.get("subtitle"))
        .and_then(|s| s.get("subtitles"))
        .and_then(|s| s.as_array())
        .cloned()
        .unwrap_or_default();

    if subs.is_empty() {
        return Ok(None);
    }

    // 优先简体中文，其次任意中文，最后取第一条
    let chosen = subs
        .iter()
        .find(|s| take_str(s, "lan").starts_with("zh-CN"))
        .or_else(|| subs.iter().find(|s| take_str(s, "lan").starts_with("zh")))
        .or_else(|| subs.first());

    let Some(chosen) = chosen else { return Ok(None) };
    let mut url = take_str(chosen, "subtitle_url");
    if url.is_empty() {
        return Ok(None);
    }
    if url.starts_with("//") {
        url = format!("https:{url}");
    }

    let body = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let lines = body
        .get("body")
        .and_then(|b| b.as_array())
        .cloned()
        .unwrap_or_default();
    let text = lines
        .iter()
        .map(|l| take_str(l, "content"))
        .collect::<Vec<_>>()
        .join("");

    if text.trim().is_empty() {
        Ok(None)
    } else {
        Ok(Some(text))
    }
}


// ---------- wbi 签名 + 搜索 ----------

const MIXIN_KEY_ENC_TAB: [usize; 64] = [
    46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35, 27, 43, 5, 49, 33, 9, 42, 19, 29,
    28, 14, 39, 12, 38, 41, 13, 37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4, 22, 25,
    54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

fn mixin_key(orig: &str) -> String {
    let bytes: Vec<char> = orig.chars().collect();
    let mut out = String::with_capacity(32);
    for &idx in MIXIN_KEY_ENC_TAB.iter().take(32) {
        if let Some(c) = bytes.get(idx) {
            out.push(*c);
        }
    }
    out
}

/// 从 nav 接口拿 img_key / sub_key，拼出 mixin key
async fn fetch_mixin_key() -> Result<String, String> {
    let resp = bili_client()?
        .get("https://api.bilibili.com/x/web-interface/nav")
        .header("Referer", "https://www.bilibili.com")
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let wbi = resp
        .get("data")
        .and_then(|d| d.get("wbi_img"))
        .ok_or("nav 里没有 wbi_img")?;

    let pick = |key: &str| -> String {
        let url = take_str(wbi, key);
        url.rsplit('/')
            .next()
            .unwrap_or("")
            .split('.')
            .next()
            .unwrap_or("")
            .to_string()
    };

    let img = pick("img_url");
    let sub = pick("sub_url");
    if img.is_empty() || sub.is_empty() {
        return Err("wbi key 解析失败".into());
    }
    Ok(mixin_key(&format!("{img}{sub}")))
}

/// 搜索视频。wbi 签名是 B 站 2023 年之后加的门槛，不带签名会直接 412。
#[tauri::command]
async fn bili_search(app: tauri::AppHandle, keyword: String, num: Option<u32>) -> Result<Vec<BiliVideo>, String> {
    use md5::{Digest, Md5};

    let num = num.unwrap_or(10).clamp(1, 30) as usize;
    let key = fetch_mixin_key().await?;
    let wts = now_ms() / 1000;

    // 参数必须按 key 字典序拼接，值里不能留 !'()* 这些字符
    let params = vec![
        ("keyword", keyword.clone()),
        ("page", "1".to_string()),
        ("page_size", "30".to_string()),
        ("search_type", "video".to_string()),
        ("wts", wts.to_string()),
    ];

    let query: String = params
        .iter()
        .map(|(k, v)| {
            let clean: String = v.chars().filter(|c| !"!'()*".contains(*c)).collect();
            format!(
                "{}={}",
                urlencode(k),
                urlencode(&clean)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    let mut hasher = Md5::new();
    hasher.update(format!("{query}{key}").as_bytes());
    let w_rid = format!("{:x}", hasher.finalize());

    let url = format!(
        "https://api.bilibili.com/x/web-interface/wbi/search/type?{query}&w_rid={w_rid}"
    );

    let mut req = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .header("Origin", "https://www.bilibili.com");

    // 有登录态就带上，搜索结果会更贴近真实用户
    if let Some(c) = load_bili_cookie(&app) {
        req = req.header(
            "Cookie",
            format!(
                "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
                c.sessdata, c.bili_jct, c.buvid3, c.dedeuserid
            ),
        );
    }

    let resp = req
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let code = take_i64(&resp, "code");
    if code != 0 {
        return Err(format!("搜索失败 code={code}"));
    }

    let items = resp
        .get("data")
        .and_then(|d| d.get("result"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(items
        .iter()
        .take(num)
        .map(|v| BiliVideo {
            bvid: take_str(v, "bvid"),
            aid: take_i64(v, "aid"),
            // 搜索结果标题带 <em class="keyword"> 高亮标签，要清掉
            title: strip_em(&take_str(v, "title")),
            owner: take_str(v, "author"),
            tname: take_str(v, "typename"),
            desc: strip_em(&take_str(v, "description")),
            view: take_i64(v, "play"),
            danmaku: take_i64(v, "video_review"),
            reply: take_i64(v, "review"),
            duration: parse_duration(&take_str(v, "duration")),
            cid: 0,
        })
        .collect())
}

fn strip_em(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut in_tag = false;
    for ch in s.chars() {
        match ch {
            '<' => in_tag = true,
            '>' => in_tag = false,
            c if !in_tag => out.push(c),
            _ => {}
        }
    }
    out.replace("&quot;", "\"").trim().to_string()
}

fn parse_duration(s: &str) -> i64 {
    let parts: Vec<i64> = s
        .split(':')
        .filter_map(|p| p.trim().parse::<i64>().ok())
        .collect();
    match parts.len() {
        2 => parts[0] * 60 + parts[1],
        3 => parts[0] * 3600 + parts[1] * 60 + parts[2],
        _ => 0,
    }
}

fn urlencode(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match *b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(*b as char)
            }
            _ => out.push_str(&format!("%{:02X}", b)),
        }
    }
    out
}


/// 读某条评论下面的楼中楼。用来发现"有人回了她"。
#[tauri::command]
async fn bili_replies_of(app: tauri::AppHandle, aid: i64, root: i64) -> Result<Vec<BiliComment>, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let url = format!("https://api.bilibili.com/x/v2/reply/reply?type=1&oid={aid}&root={root}&ps=20&pn=1");
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Ok(vec![]);
    }
    let replies = resp
        .get("data")
        .and_then(|d| d.get("replies"))
        .and_then(|r| r.as_array())
        .cloned()
        .unwrap_or_default();

    Ok(replies
        .iter()
        .map(|r| BiliComment {
            user: r.get("member").map(|m| take_str(m, "uname")).unwrap_or_default(),
            message: r
                .get("content")
                .map(|c| take_str(c, "message"))
                .unwrap_or_default()
                .replace('\n', " "),
            like: take_i64(r, "like"),
            mid: r.get("member").map(|m| take_i64(m, "mid")).unwrap_or(0),
            rpid: take_i64(r, "rpid"),
        })
        .collect())
}

/// 谁回复了我。
///
/// 不用去几千条评论里翻自己那条——B 站的通知接口直接把该有的都给了：
/// subject_id 是视频 aid，root_id 是我那层楼的 rpid，source_id 是对方回复的 rpid，
/// source_content 是对方说的话。发楼中楼正好就要 root + parent 这两个号。
#[tauri::command]
async fn bili_my_replies(app: tauri::AppHandle, ps: Option<u32>) -> Result<serde_json::Value, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let ps = ps.unwrap_or(20).clamp(1, 20);
    let url = format!(
        "https://api.bilibili.com/x/msgfeed/reply?platform=web&build=0&mobi_app=web&pn=1&ps={ps}"
    );
    let resp = bili_client()?
        .get(url)
        .header("Referer", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Err(format!("通知接口 code={}", take_i64(&resp, "code")));
    }

    let items = resp
        .get("data")
        .and_then(|d| d.get("items"))
        .and_then(|i| i.as_array())
        .cloned()
        .unwrap_or_default();

    let list: Vec<serde_json::Value> = items
        .iter()
        .filter_map(|it| {
            let item = it.get("item")?;
            let user = it.get("user").cloned().unwrap_or(serde_json::Value::Null);
            let nick = take_str(&user, "nickname");

            Some(serde_json::json!({
                "id": take_i64(it, "id"),
                "mid": take_i64(&user, "mid"),
                "nickname": nick,
                "aid": take_i64(item, "subject_id"),
                "rootId": take_i64(item, "root_id"),
                "sourceId": take_i64(item, "source_id"),
                // source_content 是对方回我的原话
                "replyContent": take_str(item, "source_content"),
                // root_reply_content 是我原本那条评论
                "myComment": take_str(item, "root_reply_content"),
                "uri": take_str(item, "uri"),
                "replyTime": take_i64(it, "reply_time"),
            }))
        })
        .collect();

    Ok(serde_json::json!({ "items": list }))
}

/// 拉评论区可用表情的全部文本标记（如 `[doge]`），前端再筛常用的给模型。
#[tauri::command]
async fn bili_emotes(app: tauri::AppHandle) -> Result<Vec<String>, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let resp = bili_client()?
        .get("https://api.bilibili.com/x/emote/setting/panel?business=reply&mobi_app=android")
        .header("Referer", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    if take_i64(&resp, "code") != 0 {
        return Err("取表情列表失败".into());
    }

    let mut out: Vec<String> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    if let Some(pkgs) = resp
        .get("data")
        .and_then(|d| d.get("user_panel_packages"))
        .and_then(|p| p.as_array())
    {
        for pkg in pkgs {
            if let Some(emotes) = pkg.get("emote").and_then(|e| e.as_array()) {
                for e in emotes {
                    let t = take_str(e, "text");
                    if !t.is_empty() && seen.insert(t.clone()) {
                        out.push(t);
                    }
                }
            }
        }
    }
    Ok(out)
}

/// 在楼中楼里回复某个人。root 是她那条评论的 rpid，parent 是要回的那条。
#[tauri::command]
async fn bili_reply_to(
    app: tauri::AppHandle,
    aid: i64,
    root: i64,
    parent: i64,
    message: String,
) -> Result<serde_json::Value, String> {
    let cookie = load_bili_cookie(&app).ok_or("还没登录 B 站")?;
    let msg = message.trim();
    if msg.is_empty() {
        return Err("回复内容为空".into());
    }
    if msg.chars().count() > 200 {
        return Err("回复太长".into());
    }

    let cookie_header = format!(
        "SESSDATA={}; bili_jct={}; buvid3={}; DedeUserID={}",
        cookie.sessdata, cookie.bili_jct, cookie.buvid3, cookie.dedeuserid
    );
    let form = [
        ("oid", aid.to_string()),
        ("type", "1".to_string()),
        ("root", root.to_string()),
        ("parent", parent.to_string()),
        ("message", msg.to_string()),
        ("csrf", cookie.bili_jct.clone()),
        ("plat", "1".to_string()),
    ];

    let resp = bili_client()?
        .post("https://api.bilibili.com/x/v2/reply/add")
        .header("Referer", "https://www.bilibili.com")
        .header("Origin", "https://www.bilibili.com")
        .header("Cookie", cookie_header)
        .form(&form)
        .send()
        .await
        .map_err(|e| e.to_string())?
        .json::<serde_json::Value>()
        .await
        .map_err(|e| e.to_string())?;

    let code = take_i64(&resp, "code");
    Ok(serde_json::json!({
        "ok": code == 0,
        "code": code,
        "message": take_str(&resp, "message"),
        "rpid": resp.get("data").and_then(|d| d.get("rpid")).and_then(|x| x.as_i64()).unwrap_or(0),
    }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_clipboard_manager::init())
        .plugin(tauri_plugin_http::init())
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, _shortcut, event| {
                    if event.state() == tauri_plugin_global_shortcut::ShortcutState::Pressed {
                        toggle_window(app);
                    }
                })
                .build(),
        )
        .manage(HitRegion(Mutex::new((0.0, 0.0, 0.0, 0.0))))
        .invoke_handler(tauri::generate_handler![
            cursor_info,
            set_hit_region,
            set_click_through,
            hide_window,
            import_cli_config,
            bili_popular,
            bili_ranking,
            bili_search,
            bili_video,
            bili_comments,
            bili_danmaku,
            bili_subtitle,
            bili_login_qr,
            bili_login_poll,
            bili_auth_status,
            bili_logout,
            bili_reply,
            bili_del_comment,
            bili_check_reply,
            bili_replies_of,
            bili_reply_to,
            bili_my_replies,
            bili_emotes
        ])
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::Moved(pos) = event {
                // 拖动时 moved 会高频触发，节流后再落盘
                let now = now_ms();
                if now.saturating_sub(LAST_POS_SAVE.load(Ordering::Relaxed)) > 500 {
                    LAST_POS_SAVE.store(now, Ordering::Relaxed);
                    save_window_pos(&window.app_handle(), pos.x, pos.y);
                }
            }
        })
        .setup(|app| {
            #[cfg(desktop)]
            {
                let win = app.get_webview_window("main").ok_or("main window missing")?;

                // Windows 上 WebView2 默认给一层不透明底色，必须显式清掉
                let _ = win.set_background_color(Some(tauri::window::Color(0, 0, 0, 0)));

                // 位置记忆：有记录且还在屏幕范围内就恢复，否则贴右下角
                let restored = load_window_pos(app.handle())
                    .filter(|(x, y)| pos_on_screen(&win, *x, *y));

                if let Some((x, y)) = restored {
                    let _ = win.set_position(tauri::PhysicalPosition::new(x, y));
                } else if let Ok(Some(monitor)) = win.current_monitor() {
                    let scale = monitor.scale_factor();
                    let size = monitor.size();
                    let w = (340.0 * scale) as i32;
                    let h = (480.0 * scale) as i32;
                    let x = size.width as i32 - w - (48.0 * scale) as i32;
                    let y = size.height as i32 - h - (96.0 * scale) as i32;
                    let pos = tauri::PhysicalPosition::new(monitor.position().x + x, monitor.position().y + y);
                    let _ = win.set_position(pos);
                    save_window_pos(app.handle(), pos.x, pos.y);
                }

                // 全局快捷键：ctrl+alt+shift+f。被占用时不 panic，托盘仍然可用。
                {
                    use tauri_plugin_global_shortcut::GlobalShortcutExt;
                    if let Err(e) = app.global_shortcut().register("ctrl+alt+shift+f") {
                        eprintln!("[shortcut] 注册失败: {e}");
                    }
                }

                // 系统托盘
                let toggle = MenuItem::with_id(app, "toggle", "显示 / 隐藏", true, None::<&str>)?;
                let settings = MenuItem::with_id(app, "settings", "设置…", true, None::<&str>)?;
                let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
                let menu = Menu::with_items(app, &[&toggle, &settings, &quit])?;

                let mut tray = TrayIconBuilder::with_id("main")
                    .tooltip("大肥鱼")
                    .menu(&menu)
                    .show_menu_on_left_click(false)
                    .on_menu_event(|app, event| match event.id.as_ref() {
                        "toggle" => toggle_window(app),
                        "settings" => {
                            if let Some(w) = app.get_webview_window("main") {
                                let _ = w.show();
                                let _ = w.set_focus();
                            }
                            let _ = app.emit("pet://open-settings", ());
                        }
                        "quit" => {
                            if let Some(w) = app.get_webview_window("main") {
                                if let Ok(pos) = w.outer_position() {
                                    save_window_pos(app, pos.x, pos.y);
                                }
                            }
                            app.exit(0);
                        }
                        _ => {}
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            button_state: MouseButtonState::Up,
                            ..
                        } = event
                        {
                            toggle_window(tray.app_handle());
                        }
                    });

                if let Some(icon) = app.default_window_icon() {
                    tray = tray.icon(icon.clone());
                }
                tray.build(app)?;

                // 光标轮询：驱动视线跟随 + 热区命中穿透判定
                let win_for_loop = win.clone();
                let handle = app.handle().clone();
                std::thread::spawn(move || loop {
                    std::thread::sleep(Duration::from_millis(50));

                    let (gx, gy) = raw_cursor_pos();
                    let (wx, wy) = match win_for_loop.outer_position() {
                        Ok(p) => (p.x, p.y),
                        Err(_) => continue,
                    };
                    let scale = win_for_loop.scale_factor().unwrap_or(1.0);
                    let rx = (gx - wx) as f64 / scale;
                    let ry = (gy - wy) as f64 / scale;

                    let region = handle
                        .state::<HitRegion>()
                        .0
                        .lock()
                        .map(|r| *r)
                        .unwrap_or((0.0, 0.0, 0.0, 0.0));

                    INSIDE.store(
                        rx >= region.0
                            && rx <= region.0 + region.2
                            && ry >= region.1
                            && ry <= region.1 + region.3,
                        Ordering::Relaxed,
                    );
                    CURSOR_X.store(rx as i32, Ordering::Relaxed);
                    CURSOR_Y.store(ry as i32, Ordering::Relaxed);
                });
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
