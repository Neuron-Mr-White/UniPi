# Footer customization

This page lists each segment of the UniPi [footer](packages/footer/README.md). It tells you how to show, hide and change segments.

## Show or hide a segment

1. Open `/unipi:settings`.
2. Select the **Footer** group.
3. Open **Segments…**.
4. Turn a group or a segment on or off.

You can also edit `~/.unipi/config/footer/config.json`:

```json
{
  "preset": "full",
  "groups": {
    "notify": { "show": true },
    "core": { "segments": { "hostname": true, "cost": false } }
  }
}
```

A segment shows when its group has `show: true` and one of these is true:

- The active preset contains the segment, and the segment value is not `false`.
- The segment value is `true`. This adds the segment to any preset.

Run `/unipi:footer-help` to see the active segments.

## Segments

"Short" is the label that the footer shows when `showFullLabels` is `false`. "Zone" is the position in the classic status line.

### core

| Segment | Short | Zone | Default | What it shows |
|---|---|---|---|---|
| `uni` | UNI | left | on | UniPi brand mark |
| `lh_mode` | MODE | left | on | Long-horizon mode: Goal, Ralph, Swarm, Graph or Regular |
| `model` | MDL | left | on | Model name |
| `api_state` | API | left | on | API connection state |
| `tool_count` | TLS | left | on | Number of tools |
| `git` | GIT | left | on | Git branch and dirty state |
| `directory` | DIR | left | on | Directory name |
| `session` | SES | left | off | Session ID |
| `hostname` | HST | left | off | Machine name |
| `tps` | TPS | center | on | Tokens per second during output |
| `context_pct` | CTX | center | on | Percent of the context window in use |
| `cost` | CST | center | on | Session cost in USD |
| `tokens_total` | TOK | center | off | Total tokens in the session |
| `tokens_in` | TIN | center | off | Input tokens |
| `tokens_out` | TOUT | center | off | Output tokens |
| `thinking_level` | THK | center | off | Thinking level of the model |
| `clock` | CLK | right | on | Time of day (HH:MM:SS) |
| `duration` | DUR | right | on | Session duration |

### Package groups

| Group | Segment | Short | Default | What it shows |
|---|---|---|---|---|
| `compactor` | `compactions` | CMP | on | Count, tokens before and after, time since the last compaction |
| `memory` | `project_count` | MEM | on | Memory entries for this project |
| `memory` | `total_count` | TOT | on | Memory entries for all projects |
| `memory` | `memory_state` | MST | on | Recall and write switches, and pending operations |
| `memory` | `consolidations` | CNS | off | Number of memory consolidations |
| `mcp` | `servers_total` | SRV | on | MCP servers in the config |
| `mcp` | `servers_active` | ACT | on | Connected MCP servers |
| `mcp` | `tools_total` | TLS | on | MCP tools |
| `mcp` | `servers_failed` | ERR | on | MCP servers that failed |
| `ralph` | `active_loops` | RL | on | Active ralph loops |
| `ralph` | `total_iterations` | ITR | on | Total loop iterations |
| `ralph` | `loop_status` | STS | on | Loop status |
| `workflow` | `current_command` | WRK | on | Active workflow command |
| `workflow` | `sandbox_level` | SBX | off | Sandbox level |
| `workflow` | `command_duration` | CDUR | on | Duration of the active command |
| `kanboard` | `docs_count` | DOC | on | Number of workflow documents |
| `kanboard` | `tasks_done` | DNE | on | Completed tasks |
| `kanboard` | `tasks_total` | TSK | on | All tasks |
| `kanboard` | `task_pct` | PCT | on | Percent of tasks complete |
| `notify` | `platforms_enabled` | NTF | on | Enabled notification platforms |
| `notify` | `last_sent` | LST | on | Time of the last notification |
| `status_ext` | `extension_statuses` | EXT | on | Status text from other extensions |

All segment groups are on by default, except `notify`. The default preset uses only some of these segments. The `full` preset uses almost all of them.

## Icons

Each segment has three icons: one for `nerd`, one for `emoji` and one for `text`. Set the style with the `iconStyle` key.

| Style | Example (`model`, `git`, `cost`) | Needs |
|---|---|---|
| `nerd` | `󰚩`, ``, `` | A Nerd Font in the terminal |
| `emoji` | `🤖`, `🔀`, `💲` | Emoji support |
| `text` | `MDL`, `GIT`, `CST` | Nothing |

With `text`, the glance frame shows labels such as `branch:main` and `workspace:unipi` in place of glyphs.

To change an icon, edit `packages/footer/src/rendering/icons.ts`. This file has three maps: `NERD_ICONS`, `EMOJI_ICONS` and `TEXT_ICONS`. The keys use camel case. For example, `project_count` uses the key `projectCount`, and `context_pct` uses the key `context`. To apply a change, run `npm run build` and restart Pi.

## Separators

| Key | Values |
|---|---|
| `separator` | `powerline`, `powerline-thin` (default), `slash`, `pipe`, `dot`, `ascii` |
| `zoneSeparator` | `│` (default), `╎`, `·`, `─`, `none` |

The `powerline` styles need a Nerd Font or a Powerline font.
