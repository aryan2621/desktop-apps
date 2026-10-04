import { invoke } from "@tauri-apps/api/core";
export const api = <T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> => invoke<T>(command, args);
