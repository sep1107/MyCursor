/// 无缝切号服务
///
/// 管理 HTTP 服务器生命周期和 workbench 注入/恢复。
use crate::error::AppError;
use crate::infra::cursor::CursorBridge;
use crate::infra::seamless::{http_server, injection_script};
use crate::{log_info, log_error};
use std::sync::atomic::{AtomicBool, AtomicU16, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;

const SEAMLESS_INTEGRITY_MARKER: &str = "/* __MYCURSOR_SEAMLESS_INTEGRITY__ */";

/// 全局服务器状态（与 Tauri 的 State 机制共存）
static SERVER_RUNNING: AtomicBool = AtomicBool::new(false);
static SERVER_PORT: AtomicU16 = AtomicU16::new(36529);

struct ServerHandle {
    stop_flag: Arc<AtomicBool>,
}

fn server_handle() -> &'static Mutex<Option<ServerHandle>> {
    static H: OnceLock<Mutex<Option<ServerHandle>>> = OnceLock::new();
    H.get_or_init(|| Mutex::new(None))
}

/// 无缝切号状态
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, specta::Type)]
pub struct SeamlessStatus {
    pub injected: bool,
    pub server_running: bool,
    pub port: u16,
    pub backup_exists: bool,
}

/// 无缝切号服务
pub struct SeamlessService {
    cursor: CursorBridge,
}

impl SeamlessService {
    pub fn new(cursor: CursorBridge) -> Self {
        Self { cursor }
    }

    /// 查询无缝切号状态
    pub fn get_status(&self) -> Result<SeamlessStatus, AppError> {
        let (injected, backup_exists) = match self.cursor.workbench().workbench_js_path() {
            Ok(wp) => {
                let injected = if wp.exists() {
                    std::fs::read_to_string(wp)
                        .map(|c| c.contains("__MYCURSOR_SEAMLESS__"))
                        .unwrap_or(false)
                } else {
                    false
                };
                let backup = self.cursor.workbench().backup_exists().unwrap_or(false);
                (injected, backup)
            }
            Err(_) => {
                // workbench 路径未找到，尝试使用自定义路径或配置查找
                (false, false)
            }
        };

        Ok(SeamlessStatus {
            injected,
            server_running: SERVER_RUNNING.load(Ordering::SeqCst),
            port: SERVER_PORT.load(Ordering::SeqCst),
            backup_exists,
        })
    }

    /// 注入 workbench
    pub fn inject(&self, port: u16) -> Result<serde_json::Value, AppError> {
        let wp = self.cursor.workbench().workbench_js_path()?.clone();
        if !wp.exists() {
            return Err(AppError::WorkbenchNotFound(wp.to_string_lossy().to_string()));
        }

        let bp = self.cursor.workbench().seamless_backup_path()?;
        let mut details = Vec::new();

        // 备份保护
        if bp.exists() {
            let bc = std::fs::read_to_string(&bp).unwrap_or_default();
            if bc.contains("__MYCURSOR_SEAMLESS__") {
                let cc = std::fs::read_to_string(&wp).unwrap_or_default();
                if !cc.contains("__MYCURSOR_SEAMLESS__") {
                    std::fs::copy(&wp, &bp)?;
                    details.push("备份已污染，已用干净文件重建".to_string());
                } else {
                    return Err(AppError::Internal("备份和当前文件都已注入，请手动恢复".to_string()));
                }
            } else {
                std::fs::copy(&bp, &wp)?;
                details.push("已从备份恢复".to_string());
            }
        } else {
            let cc = std::fs::read_to_string(&wp).unwrap_or_default();
            if cc.contains("__MYCURSOR_SEAMLESS__") {
                return Err(AppError::Internal("已注入但无备份，请手动恢复".to_string()));
            }
            std::fs::copy(&wp, &bp)?;
            details.push(format!("已创建备份: {}", bp.display()));
        }

        let mut content = std::fs::read_to_string(&wp)?;
        let orig_len = content.len();

        // 步骤 1: 提前返回，阻止被修改文件的完整性警告弹窗
        let t1 = "_showNotification(){";
        if !content.contains(t1) {
            return Err(AppError::Internal(
                "未找到 _showNotification() 完整性检查锚点，当前 Cursor 版本可能不兼容无感换号"
                    .to_string(),
            ));
        }
        content = content.replacen(
            t1,
            &format!(
                "_showNotification(){{{}return;",
                SEAMLESS_INTEGRITY_MARKER
            ),
            1,
        );
        details.push("步骤1: 已禁用文件完整性警告弹窗".to_string());

        // 步骤 2: hook AuthService
        let t2 = "addLoginChangedListener(e){this.loginChangedListeners.push(e)}";
        if content.contains(t2) {
            let replacement = "addLoginChangedListener(e){this.loginChangedListeners.push(e);window.__mcAuthService=this}";
            content = content.replacen(t2, replacement, 1);
            details.push("步骤2: Auth Service 钩子 OK".to_string());
        }

        // 步骤 3: 追加尾部脚本
        let script = injection_script::build(port);
        content.push_str(&script);
        details.push("步骤3: 监听脚本已追加".to_string());

        std::fs::write(&wp, &content)?;

        log_info!("[无感换号] 注入完成: {} -> {} 字节", orig_len, content.len());

        Ok(serde_json::json!({
            "success": true,
            "message": format!("注入成功 (端口 {})", port),
            "details": details,
            "port": port
        }))
    }

    /// 恢复原始 workbench
    pub fn restore(&self) -> Result<serde_json::Value, AppError> {
        let wp = self.cursor.workbench().workbench_js_path()?.clone();
        let bp = self.cursor.workbench().seamless_backup_path()?;

        if !bp.exists() {
            return Ok(serde_json::json!({"success": false, "message": "无备份"}));
        }

        std::fs::copy(&bp, &wp)?;
        log_info!("[无感换号] 已恢复");

        Ok(serde_json::json!({"success": true, "message": "已恢复，请重启 Cursor"}))
    }

    /// 启动 HTTP 服务器
    pub fn start_server(&self, port: u16) -> Result<(), AppError> {
        let mut h = server_handle().lock()
            .map_err(|e| AppError::SeamlessServerError(e.to_string()))?;

        if h.is_some() {
            return Err(AppError::SeamlessServerError("服务器已在运行".to_string()));
        }

        let stop = Arc::new(AtomicBool::new(false));
        let stop_clone = stop.clone();

        let data_dir = crate::get_data_dir()
            .map_err(|e| AppError::Internal(e))?;

        thread::spawn(move || {
            SERVER_RUNNING.store(true, Ordering::SeqCst);
            SERVER_PORT.store(port, Ordering::SeqCst);
            http_server::run(port, &data_dir, &stop_clone);
            SERVER_RUNNING.store(false, Ordering::SeqCst);
        });

        thread::sleep(std::time::Duration::from_millis(200));
        *h = Some(ServerHandle { stop_flag: stop });

        Ok(())
    }

    /// 停止 HTTP 服务器
    pub fn stop_server(&self) -> Result<(), AppError> {
        let mut h = server_handle().lock()
            .map_err(|e| AppError::SeamlessServerError(e.to_string()))?;

        match h.take() {
            Some(s) => {
                s.stop_flag.store(true, Ordering::SeqCst);
                thread::sleep(std::time::Duration::from_millis(600));
                Ok(())
            }
            None => Err(AppError::SeamlessServerError("服务器未运行".to_string())),
        }
    }
}
