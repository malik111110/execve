import * as vscode from "vscode";
import type { PermissionMode } from "../../types";

export function normalizePermissionMode(value: string | undefined): PermissionMode {
  const normalized = (value || "").trim().toLowerCase();
  if (normalized === "bypassapproval" || normalized === "bypass_approval") {
    return "bypassApproval";
  }

  if (normalized === "autopilot" || normalized === "auto") {
    return "autopilot";
  }

  return "defaultApproval";
}

export function permissionModeLabel(mode: PermissionMode): string {
  if (mode === "bypassApproval") {
    return "Bypass Approvals";
  }

  if (mode === "autopilot") {
    return "Autopilot";
  }

  return "Default Approvals";
}

export function readStringArraySetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string
): string[] {
  const raw = configuration.get<unknown>(key, []);
  if (!Array.isArray(raw)) {
    return [];
  }

  return raw
    .map((entry) => String(entry).trim())
    .filter((entry) => entry.length > 0);
}
