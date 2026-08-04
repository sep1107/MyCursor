import { useState, useEffect, useRef, memo, useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AccountService } from "@/services/accountService";
import { FormField, TextInput, TextareaInput } from "@/components/form/FormField";
import { TagSelector } from "@/components/TagSelector";
import Modal from "@/components/Modal";
import { base64URLEncode, K, sha256 } from "@/utils/cursorToken";

interface AddAccountFormProps {
  isOpen: boolean;
  onSuccess: (email: string) => void;
  onCancel: () => void;
  onToast: (message: string, type: "success" | "error") => void;
}

export const AddAccountForm = memo(({ isOpen, onSuccess, onCancel, onToast }: AddAccountFormProps) => {
  const [newEmail, setNewEmail] = useState("");
  const [newToken, setNewToken] = useState("");
  const [newRefreshToken, setNewRefreshToken] = useState("");
  const [newWorkosSessionToken, setNewWorkosSessionToken] = useState("");
  const [fetchingAccessToken, setFetchingAccessToken] = useState(false);
  const [fetchingSessionToken, setFetchingSessionToken] = useState(false);
  const [newTags, setNewTags] = useState<string[]>([]);
  const [showMachineIds, setShowMachineIds] = useState(false);
  const [machineIdsJson, setMachineIdsJson] = useState("");
  const [machineIdsParseError, setMachineIdsParseError] = useState("");
  const [parsedMachineIds, setParsedMachineIds] = useState<Record<string, string>>({});

  const sessionTokenUnlistenRef = useRef<(() => void) | null>(null);
  const sessionLoginClosedUnlistenRef = useRef<(() => void) | null>(null);

  const clearSessionLoginListeners = useCallback(() => {
    sessionTokenUnlistenRef.current?.();
    sessionTokenUnlistenRef.current = null;
    sessionLoginClosedUnlistenRef.current?.();
    sessionLoginClosedUnlistenRef.current = null;
  }, []);

  useEffect(() => {
    if (isOpen) {
      setNewEmail("");
      setNewToken("");
      setNewRefreshToken("");
      setNewWorkosSessionToken("");
      setFetchingAccessToken(false);
      setFetchingSessionToken(false);
      setNewTags([]);
      setShowMachineIds(false);
      setMachineIdsJson("");
      setMachineIdsParseError("");
      setParsedMachineIds({});
    }

    return clearSessionLoginListeners;
  }, [clearSessionLoginListeners, isOpen]);

  const handleOpenLoginForSessionToken = useCallback(async () => {
    setFetchingSessionToken(true);
    onToast("正在打开登录页面，请在浏览器中完成登录...", "success");

    try {
      clearSessionLoginListeners();

      const unlisten = await listen<{ token: string }>("session-token-obtained", (event) => {
        const token = event.payload?.token;
        if (token) {
          setNewWorkosSessionToken(token);
          onToast("SessionToken 获取成功！", "success");
        }
        setFetchingSessionToken(false);
        clearSessionLoginListeners();
      });
      sessionTokenUnlistenRef.current = unlisten;

      const unlistenClosed = await listen("session-token-login-closed", () => {
        setFetchingSessionToken(false);
        clearSessionLoginListeners();
      });
      sessionLoginClosedUnlistenRef.current = unlistenClosed;

      await invoke("open_login_for_session_token");
    } catch (error) {
      console.error("打开登录窗口失败:", error);
      onToast("打开登录窗口失败", "error");
      setFetchingSessionToken(false);
      clearSessionLoginListeners();
    }
  }, [clearSessionLoginListeners, onToast]);

  const getClientAccessToken = useCallback(async (sessionToken: string) => {
    try {
      const verifier = base64URLEncode(K);
      const challenge = base64URLEncode(new Uint8Array(await sha256(verifier)));
      const uuid = crypto.randomUUID();

      await invoke("trigger_authorization_login", {
        uuid,
        challenge,
        workosCursorSessionToken: sessionToken,
      });

      return new Promise((resolve) => {
        const interval = setInterval(() => {
          invoke("trigger_authorization_login_poll", { uuid, verifier })
            .then((res: any) => {
              if (res.success) {
                resolve(JSON.parse(res.response_body));
                clearInterval(interval);
              }
            })
            .catch(() => {});
        }, 1000);

        setTimeout(() => {
          clearInterval(interval);
          resolve(null);
        }, 20000);
      });
    } catch (error) {
      console.error("获取 AccessToken 失败:", error);
      return null;
    }
  }, []);

  const handleFetchAccessToken = useCallback(async () => {
    if (!newWorkosSessionToken.trim()) {
      onToast("请先获取或输入 WorkOS Session Token", "error");
      return;
    }

    setFetchingAccessToken(true);
    try {
      const result: any = await getClientAccessToken(newWorkosSessionToken.trim());
      if (!result?.accessToken) {
        onToast("获取 AccessToken 失败，请检查 Session Token 是否有效", "error");
        return;
      }

      setNewToken(result.accessToken);
      if (result.refreshToken) setNewRefreshToken(result.refreshToken);

      try {
        const meResult = await AccountService.getAuthMe(newWorkosSessionToken.trim());
        if (meResult.success && meResult.data?.email) {
          setNewEmail(meResult.data.email);
          onToast(`获取成功！用户: ${meResult.data.name || meResult.data.email}`, "success");
        } else {
          console.warn("getAuthMe 返回失败:", meResult);
          onToast("AccessToken 获取成功！但无法自动获取邮箱，请手动输入", "success");
        }
      } catch (meError) {
        console.error("getAuthMe 异常:", meError);
        onToast("AccessToken 获取成功！但获取邮箱时出错，请手动输入", "success");
      }
    } catch (error) {
      console.error("获取 AccessToken 失败:", error);
      onToast("获取 AccessToken 时发生错误", "error");
    } finally {
      setFetchingAccessToken(false);
    }
  }, [newWorkosSessionToken, getClientAccessToken, onToast]);

  const REQUIRED_MACHINE_ID_KEYS = [
    "telemetry.devDeviceId",
    "telemetry.macMachineId",
    "telemetry.machineId",
    "telemetry.sqmId",
    "storage.serviceMachineId",
  ] as const;

  const OPTIONAL_MACHINE_ID_KEYS = ["system.machineGuid", "system.sqmClientId"] as const;

  const parseMachineIdsFromJson = useCallback((json: string) => {
    if (!json.trim()) {
      setParsedMachineIds({});
      setMachineIdsParseError("");
      return;
    }

    try {
      const data = JSON.parse(json);
      const ids: Record<string, string> = {};
      const missing: string[] = [];

      for (const key of REQUIRED_MACHINE_ID_KEYS) {
        if (data[key] && typeof data[key] === "string") {
          ids[key] = data[key];
        } else {
          missing.push(key.split(".").pop() || key);
        }
      }

      for (const key of OPTIONAL_MACHINE_ID_KEYS) {
        if (data[key] && typeof data[key] === "string") {
          ids[key] = data[key];
        }
      }

      if (missing.length > 0) {
        setMachineIdsParseError(`缺少必须字段: ${missing.join(", ")}`);
        setParsedMachineIds({});
      } else {
        setParsedMachineIds(ids);
        setMachineIdsParseError("");
      }
    } catch {
      setMachineIdsParseError("JSON 格式错误，请粘贴完整的 storage.json 内容");
      setParsedMachineIds({});
    }
  }, []);

  const handleAddAccount = useCallback(async () => {
    if (!newEmail || !newEmail.includes("@")) {
      onToast("请输入有效的邮箱地址", "error");
      return;
    }
    if (!newToken) {
      onToast("请先获取 AccessToken", "error");
      return;
    }

    if (showMachineIds && machineIdsJson.trim()) {
      const hasAllRequired = REQUIRED_MACHINE_ID_KEYS.every((key) => parsedMachineIds[key]);
      if (machineIdsParseError || !hasAllRequired) {
        onToast("机器码绑定失败：请确保包含全部 5 个必须字段", "error");
        return;
      }
    }

    try {
      const result = await AccountService.addAccount(
        newEmail,
        newToken,
        newRefreshToken || undefined,
        newWorkosSessionToken || undefined,
        newTags.length > 0 ? newTags : undefined
      );

      if (result.success) {
        if (showMachineIds && REQUIRED_MACHINE_ID_KEYS.every((key) => parsedMachineIds[key])) {
          await AccountService.editAccount(
            newEmail,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            parsedMachineIds
          );
        }
        onToast(result.message || "账户添加成功", "success");
        onSuccess(newEmail);
      } else {
        onToast(result.message, "error");
      }
    } catch (error) {
      console.error("添加账户失败:", error);
      onToast("添加账户失败", "error");
    }
  }, [
    newEmail,
    newToken,
    newRefreshToken,
    newWorkosSessionToken,
    newTags,
    showMachineIds,
    machineIdsJson,
    machineIdsParseError,
    parsedMachineIds,
    onToast,
    onSuccess,
  ]);

  const actionBtnStyle = (color: string, disabled = false) => ({
    padding: "8px 14px",
    fontSize: "13px",
    fontWeight: "500" as const,
    color: "white",
    backgroundColor: disabled ? "var(--bg-secondary)" : color,
    border: "none",
    borderRadius: "var(--border-radius)",
    cursor: disabled ? "not-allowed" : "pointer",
    opacity: disabled ? 0.5 : 1,
    transition: "all var(--transition-duration) ease",
    whiteSpace: "nowrap" as const,
  });

  return (
    <Modal
      open={isOpen}
      onClose={onCancel}
      title="添加新账户"
      size="lg"
      footer={
        <>
          <button
            onClick={onCancel}
            style={{
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: "500",
              color: "var(--text-primary)",
              backgroundColor: "var(--bg-primary)",
              border: "1px solid var(--border-primary)",
              borderRadius: "var(--border-radius)",
              cursor: "pointer",
              transition: "all var(--transition-duration) ease",
            }}
            onMouseEnter={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-secondary)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.backgroundColor = "var(--bg-primary)";
            }}
          >
            取消
          </button>
          <button
            onClick={handleAddAccount}
            disabled={!newEmail || !newToken}
            style={{
              padding: "8px 16px",
              fontSize: "14px",
              fontWeight: "500",
              color: "white",
              backgroundColor: !newEmail || !newToken ? "var(--bg-secondary)" : "var(--primary-color)",
              border: "none",
              borderRadius: "var(--border-radius)",
              cursor: !newEmail || !newToken ? "not-allowed" : "pointer",
              opacity: !newEmail || !newToken ? 0.5 : 1,
              transition: "all var(--transition-duration) ease",
            }}
            onMouseEnter={(e) => {
              if (newEmail && newToken) {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.boxShadow = "var(--shadow-medium)";
              }
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "translateY(0)";
              e.currentTarget.style.boxShadow = "none";
            }}
          >
            添加账户
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <FormField
          label="WorkOS Session Token"
          description="通过登录获取，或直接粘贴已有的 Session Token"
        >
          <TextareaInput
            value={newWorkosSessionToken}
            onChange={setNewWorkosSessionToken}
            placeholder="点击下方按钮登录获取，或直接粘贴"
            rows={3}
          />
          <div className="flex gap-2 mt-2">
            <button
              onClick={handleOpenLoginForSessionToken}
              disabled={fetchingSessionToken}
              style={actionBtnStyle("var(--primary-color)", fetchingSessionToken)}
            >
              {fetchingSessionToken ? "等待登录中..." : "登录获取 SessionToken"}
            </button>
            <button
              onClick={handleFetchAccessToken}
              disabled={fetchingAccessToken || !newWorkosSessionToken.trim()}
              style={actionBtnStyle("#10b981", fetchingAccessToken || !newWorkosSessionToken.trim())}
            >
              {fetchingAccessToken ? "获取中..." : "获取 AccessToken"}
            </button>
          </div>
        </FormField>

        <FormField label="邮箱地址" required description="获取 AccessToken 时会自动填充">
          <TextInput
            type="email"
            value={newEmail}
            onChange={setNewEmail}
            placeholder="获取 AccessToken 后自动填入"
          />
        </FormField>

        <FormField label="Access Token" required>
          <TextareaInput
            value={newToken}
            onChange={setNewToken}
            placeholder="获取 AccessToken 后自动填入，或手动粘贴"
            rows={3}
          />
        </FormField>

        <FormField label="Refresh Token" description="用于自动刷新 Access Token（可选）">
          <TextareaInput
            value={newRefreshToken}
            onChange={setNewRefreshToken}
            placeholder="获取 AccessToken 后自动填入（可选）"
            rows={3}
          />
        </FormField>

        <FormField label="标签" description="选择预设标签或输入新标签回车创建">
          <TagSelector selectedTags={newTags} onChange={setNewTags} />
        </FormField>

        <div>
          <button
            type="button"
            onClick={() => setShowMachineIds(!showMachineIds)}
            className="flex items-center gap-1 text-sm font-medium mb-2"
            style={{
              color: "var(--primary-color)",
              background: "none",
              border: "none",
              cursor: "pointer",
              padding: 0,
            }}
          >
            <span
              style={{
                transform: showMachineIds ? "rotate(90deg)" : "rotate(0)",
                transition: "0.2s",
                display: "inline-block",
              }}
            >
              &#9654;
            </span>
            绑定机器码（可选）
          </button>
          {showMachineIds && (
            <div
              className="p-3 rounded"
              style={{
                backgroundColor: "var(--bg-secondary)",
                border: "1px solid var(--border-primary)",
              }}
            >
              <p className="text-xs mb-2" style={{ color: "var(--text-tertiary)" }}>
                粘贴 storage.json 内容，自动提取 5 个必须字段。
                如需绑定注册表 ID（machineGuid、sqmClientId），请手动添加到 JSON 中。
                <br />
                路径：%APPDATA%\Cursor\User\globalStorage\storage.json
              </p>
              <TextareaInput
                value={machineIdsJson}
                onChange={(value) => {
                  setMachineIdsJson(value);
                  parseMachineIdsFromJson(value);
                }}
                placeholder="粘贴 storage.json 内容（JSON 格式）"
                rows={4}
              />
              {machineIdsParseError && (
                <p className="text-xs mt-1" style={{ color: "#ef4444" }}>
                  {machineIdsParseError}
                </p>
              )}
              {!machineIdsParseError && Object.keys(parsedMachineIds).length >= 5 && (
                <div className="mt-2 text-xs space-y-0.5" style={{ color: "#10b981" }}>
                  {Object.entries(parsedMachineIds).map(([key, value]) => (
                    <p key={key} className="font-mono truncate">
                      {key.split(".").pop()}: {String(value).slice(0, 30)}...
                    </p>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
});

AddAccountForm.displayName = "AddAccountForm";
