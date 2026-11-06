import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { findWelcomeNoticeVersion, welcomeSettingsDocument } from "./onboarding.mjs";

function presetWelcomeNotice({ isolatedHome, dshAbs, out, outWarn }) {
  const settingsPath = join(isolatedHome, "settings.yaml");
  const found = findWelcomeNoticeVersion(dshAbs);
  if (!found) {
    outWarn(
      "警告: 未能从 dsh 产物提取内测声明版本与命名空间（布局或客户端常量变化？）——首启「内测声明」弹窗保留，由 browser-driver 导航后兜底跳过",
    );
    return {
      skip: true,
      source: "unavailable",
      version: null,
      namespace: null,
      settingsFile: settingsPath,
    };
  }
  if (existsSync(settingsPath)) {
    outWarn(`警告: ${settingsPath} 已存在，跳过预置（不覆盖既有设置文档）`);
    return {
      skip: true,
      source: "existing",
      version: found.version,
      namespace: found.namespace,
      settingsFile: settingsPath,
    };
  }
  try {
    writeFileSync(settingsPath, welcomeSettingsDocument(found.version, found.namespace), {
      mode: 0o600,
    });
  } catch (error) {
    outWarn(
      `警告: 首启弹窗预置写入失败（${error.message}）——首启「内测声明」弹窗保留，由 browser-driver 兜底跳过`,
    );
    return {
      skip: true,
      source: "write-failed",
      version: found.version,
      namespace: found.namespace,
      settingsFile: settingsPath,
      error: error.message,
    };
  }
  out(
    `首启弹窗预置: 内测声明 ${found.namespace}.welcomeNoticeVersion=${found.version} → ${settingsPath}（--no-skip-onboarding 可关闭）`,
  );
  return {
    skip: true,
    source: "preset",
    version: found.version,
    namespace: found.namespace,
    clientFile: found.file,
    settingsFile: settingsPath,
  };
}

export function resetOnboardingPreset(flags, deps) {
  return flags.skipOnboarding
    ? presetWelcomeNotice(deps)
    : {
        skip: false,
        source: "disabled",
        version: null,
        namespace: null,
        settingsFile: join(deps.isolatedHome, "settings.yaml"),
      };
}
