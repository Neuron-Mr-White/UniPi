---
name: notify
description: >
  Cross-platform notification system for Pi. Use notify_user when you need
  to urgently alert the user about critical findings, errors, or completion
  of long-running tasks.
allowed-tools:
  - notify_user
---

# Notify User

Use the `notify_user` tool to send notifications to the user's configured
platforms (native OS, Gotify, Telegram).

## When to use notify_user

- Critical errors that need immediate attention
- Completion of long-running tasks (after user has been waiting)
- Security concerns or suspicious activity detected
- Results that the user explicitly asked to be notified about

## When NOT to use notify_user

- Routine status updates (use normal message instead)
- Non-urgent information (let user read at their pace)
- Every turn completion (spammy)

## Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `message` | string | required | Notification body |
| `title` | string? | "Pi Notification" | Notification title |
| `priority` | string? | "normal" | "low", "normal", or "high" |
| `platforms` | string[]? | all enabled | Override which platforms to use |

## Examples

Alert on critical error:
```
notify_user({
  title: "Build Failed",
  message: "TypeScript compilation failed with 12 errors. Check src/auth.ts.",
  priority: "high"
})
```

Task completion:
```
notify_user({
  title: "Deployment Complete",
  message: "Successfully deployed to production. All health checks passed.",
  priority: "normal"
})
```
