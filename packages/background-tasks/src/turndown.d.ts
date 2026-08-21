/** Turndown has no bundled type declarations; we use a narrow surface. */
declare module "turndown" {
  interface TurndownService {
    turndown(html: string): string;
    addRule(key: string, rule: unknown): TurndownService;
    remove(tags: string | string[]): TurndownService;
    keep(tags: string | string[]): TurndownService;
    use(plugin: unknown): TurndownService;
  }
  interface TurndownConstructor {
    new (options?: Record<string, unknown>): TurndownService;
  }
  const TurndownService: TurndownConstructor;
  export default TurndownService;
}
