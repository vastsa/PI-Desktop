import { Type } from "@earendil-works/pi-ai";

const schedule = Type.Object({
  hour: Type.Integer({ minimum: 0, maximum: 23 }),
  minute: Type.Integer({ minimum: 0, maximum: 59 }),
  weekday: Type.Integer({ minimum: 0, maximum: 6, description: "Monday=0. Use 0 for daily/hourly schedules." }),
  weekdays: Type.Optional(Type.Array(Type.Integer({ minimum: 0, maximum: 6 }), { minItems: 1, maxItems: 7, uniqueItems: true })),
}, { additionalProperties: false });
const cadence = Type.Union([Type.Literal("manual"), Type.Literal("hourly"), Type.Literal("daily"), Type.Literal("weekly")]);
const title = Type.String({ minLength: 1, maxLength: 80 });
const prompt = Type.String({ minLength: 1, maxLength: 64000 });

export const scheduledToolParameters: Record<string, Parameters<typeof Type.Object>[0]> = {
  scheduled_task_list: {},
  scheduled_task_create: { title, prompt, cadence, schedule: Type.Optional(schedule), enabled: Type.Optional(Type.Boolean()) },
  scheduled_task_update: { id: Type.String(), title: Type.Optional(title), prompt: Type.Optional(prompt), cadence: Type.Optional(cadence), schedule: Type.Optional(schedule), enabled: Type.Optional(Type.Boolean()) },
  scheduled_task_delete: { id: Type.String() },
};

export const scheduledToolDescriptions: Record<string, string> = {
  scheduled_task_list: "List scheduled automations in this conversation's project, including IDs, exact times and enabled state. Use before updating or deleting; never guess IDs.",
  scheduled_task_create: "Create a scheduled automation in this conversation's project. Requires app running. Hourly waits one hour; daily/weekly require a local-time schedule. Time defaults: morning 09:00, afternoon 14:00, evening 19:00, night 22:00; use an exact requested time when given. Weekly may select multiple weekdays. Never create a recurring task unless the user requests it.",
  scheduled_task_update: "Update a listed automation in this conversation's project. Change its exact local hour/minute, prompt, cadence, title, or enabled flag (false pauses, true resumes). Preserve unspecified fields. For a time change, supply the full schedule and retain its existing weekdays. Only modify the task requested by the user.",
  scheduled_task_delete: "Delete a listed automation and its run history in this conversation's project, only when the user requests deletion. A currently running task cannot be deleted.",
};
