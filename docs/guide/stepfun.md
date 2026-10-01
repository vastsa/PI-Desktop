# StepFun Plan

## Connect the subscription endpoint

1. Open **Settings → Model configuration → Add AI service**.
2. Select **StepFun Plan** and enter the API key for that subscription.
3. Fetch the model list, select `step-5-preview`, and save.

The preset uses `https://api.stepfun.com/step_plan/v1` with **Anthropic
Messages**. The runtime sends requests to `/step_plan/v1/messages`; it does
not send subscription requests to the ordinary `/v1/messages` endpoint or
append a second `/v1` segment. The API format remains editable in Advanced.

Model availability still comes from the endpoint. If model discovery is
unavailable, add the exact model ID manually. Published limits, input
modalities, and thinking levels come from the bundled first-party models.dev
record; explicit model settings remain authoritative.

The ordinary StepFun API remains available through a custom endpoint. Existing
saved services are not rewritten when this preset is added.

See the [official Step Plan API integration guide](https://platform.stepfun.com/docs/zh/step-plan/integrations/reasoning-api).
