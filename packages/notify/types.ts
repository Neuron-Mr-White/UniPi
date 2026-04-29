/**
 * @pi-unipi/notify — TypeScript type definitions
 */

/** Supported notification platforms */
export type NotifyPlatform = "native" | "gotify" | "telegram" | "ntfy";

/** Per-event notification configuration */
export interface EventNotifyConfig {
  /** Whether this event type is enabled */
  enabled: boolean;
  /** Platforms to send to (empty = use global defaults) */
  platforms: NotifyPlatform[];
}

/** Native notification platform config */
export interface NativeConfig {
  /** Whether native notifications are enabled */
  enabled: boolean;
  /** Windows appID to show instead of "SnoreToast" */
  windowsAppId?: string;
}

/** Gotify notification platform config */
export interface GotifyConfig {
  /** Whether Gotify is enabled */
  enabled: boolean;
  /** Gotify server URL */
  serverUrl?: string;
  /** Gotify app token */
  appToken?: string;
  /** Priority level (1-10) */
  priority: number;
}

/** Telegram notification platform config */
export interface TelegramConfig {
  /** Whether Telegram is enabled */
  enabled: boolean;
  /** Telegram bot token */
  botToken?: string;
  /** Telegram chat ID */
  chatId?: string;
}

/** ntfy notification platform config */
export interface NtfyConfig {
  /** Whether ntfy is enabled */
  enabled: boolean;
  /** ntfy server URL (default: https://ntfy.sh) */
  serverUrl?: string;
  /** ntfy topic to publish to */
  topic?: string;
  /** Optional access token for authenticated ntfy servers */
  token?: string;
  /** Priority level (1-5, default: 3) */
  priority: number;
}

/** Full notification configuration */
export interface NotifyConfig {
  /** Global default platforms for all events */
  defaultPlatforms: NotifyPlatform[];
  /** Per-event type overrides */
  events: Record<string, EventNotifyConfig>;
  /** Native platform settings */
  native: NativeConfig;
  /** Gotify settings */
  gotify: GotifyConfig;
  /** Telegram settings */
  telegram: TelegramConfig;
  /** ntfy settings */
  ntfy: NtfyConfig;
}

/** Parameters for the notify_user agent tool */
export interface NotifyUserParams {
  /** Notification message body */
  message: string;
  /** Notification title (default: "Pi Notification") */
  title?: string;
  /** Priority level */
  priority?: "low" | "normal" | "high";
  /** Override platforms for this notification */
  platforms?: NotifyPlatform[];
}

/** Result of sending a notification to a single platform */
export interface NotifyResult {
  /** Platform that was targeted */
  platform: NotifyPlatform;
  /** Whether the send succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/** Notification dispatch summary */
export interface NotifyDispatchResult {
  /** Results per platform */
  results: NotifyResult[];
  /** Whether all platforms succeeded */
  allSuccess: boolean;
}
