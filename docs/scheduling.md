# Flocky scheduling

A project owner creates confirmed schedules with `flocky_schedule_create`. Definitions and idempotent occurrence claims live in `.pi/flocky/flocky.db`; Windows Task Scheduler is only the local clock.

## Windows task action

Install one task per job on the designated owner/scheduler host. Its action must be a lightweight runner invocation (update paths for the host):

```powershell
node C:\Users\<you>\Documents\my-project\tools\flocky-schedule.mjs --cwd C:\Users\<you>\Documents\my-project --job daily-example-bot-message-0900
```

Configure the trigger using the job's declared timezone and cron-equivalent frequency. Give each Windows task a stable name such as `Flocky_example_daily-example-bot-message-0900`.

The runner validates the enabled job, configured recipient route, protocol secret, and durable occurrence claim before dispatching the normal signed Flocky envelope. Its default occurrence key includes the job's declared timezone, date, and hour, so hourly jobs run once per intended hour while duplicate launches in that hour are skipped. Do not put task text or credentials in Task Scheduler.

For jobs with `missedRunPolicy: "skip"`, do not enable Windows `StartWhenAvailable`: a delayed laptop wake must not replay missed external or time-sensitive work.

Scheduled task results can be returned to a running owner Pi through the normal Flocky route. Dispatch itself does not require the owner Pi to be open.
