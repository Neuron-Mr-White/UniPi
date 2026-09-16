# Unipi Architecture Docs (/docs)



C4-model architecture documentation for **Unipi** — a TypeScript monorepo of \~25 extension
packages (`@pi-unipi/*`) that extend the **Pi coding agent**.

Generated with [Litho / deepwiki-rs](https://github.com/sopaco/deepwiki-rs) using
`openrouter/anthropic/claude-fable-5.1` (smart) and `ds/deepseek-flash` (worker).

## Contents [#contents]

| Section                                                          | What it covers                                                |
| ---------------------------------------------------------------- | ------------------------------------------------------------- |
| [Overview](overview/)                                            | System context, target users, capability clusters, tech stack |
| [Architecture](architecture/)                                    | Containers, components, the `UNIPI_EVENTS` bus, coupling      |
| [Workflow](workflow/)                                            | Compaction pipeline, orchestration, delegation, lifecycle     |
| [Deep Exploration](deep-exploration/agent-orchestration-domain/) | Six bounded contexts of the suite                             |
| [Boundary Interfaces](boundary-interfaces/)                      | Commands, tools, hooks, MCP bridges, HTTP surfaces            |
| [Database Overview](database-overview/)                          | SQLite session store and on-disk state                        |

> This site is recrafted from the generated Markdown: plain-Markdown compilation,
> native Mermaid rendering, light/dark themes and full-text search.
