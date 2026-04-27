declare module "node-notifier" {
  interface Notification {
    title?: string;
    message?: string;
    appID?: string;
    sound?: boolean | string;
    icon?: string;
    wait?: boolean;
  }

  interface Notifier {
    notify(
      notification: Notification,
      callback: (err: Error | null, data: any) => void
    ): void;
  }

  const notifier: Notifier;
  export default notifier;
}
