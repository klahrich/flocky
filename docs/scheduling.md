# Flocky scheduling

A project owner creates confirmed schedules with `flocky_schedule_create`. Definitions and idempotent occurrence claims live in `.pi/flocky/flocky.db`; Windows Task Scheduler is only the local clock.

## Windows task action

Install one task per job on the designated owner/scheduler host. Its action must be a lightweight runner invocation (update paths for the host):

```powershell
node C:\Users\<you>\Documents\my-project\tools\flocky-schedule.mjs --cwd C:\Users\<you>\Documents\my-project --job daily-example-bot-message-0900
```

Configure the trigger using the job's declared timezone and cron-equivalent frequency. Give each Windows task a stable name such as `Flocky_example_daily-example-bot-message-0900`.

The runner validates the enabled job, configured recipient route, protocol secret, and durable occurrence claim before dispatching the normal signed Flocky envelope. Duplicate occurrence keys are skipped. Do not put task text or credentials in Task Scheduler.

Scheduled task results can be returned to a running owner Pi through the normal Flocky route. Dispatch itself does not require the owner Pi to be open.
