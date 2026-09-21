# StepFun Step 5 Preview

## Unreleased change

Add StepFun to the AI-service picker and support Step 5 Preview with its
first-party context, vision, tool and reasoning capabilities.

## Setup

1. Open **Settings → Model configuration → Add AI service**.
2. Select **StepFun** and enter your StepFun API key. The preset uses
   `https://api.stepfun.com/v1` and Chat Completions.
3. Fetch the model list and select `step-5-preview`, then save.
4. Select the saved model in a conversation. Choose low, medium or high
   thinking intensity, or retain the default medium.

If the service cannot list models, add `step-5-preview` as a custom model ID
on that same StepFun service. API entitlement is still required.

The official endpoint reports a 1,024,000-token input limit, used here as a
conservative context window. The output cap uses a conservative 64,000 tokens from the documented 64k limit.
Text, images and tool calls use the existing conversation pipeline. The model's
video capability does not enable video attachments in PI-Desktop.

Advanced per-model overrides remain available. Existing custom gateways keep
their own configuration; the official-endpoint supplement does not apply to
Step Plan or reseller URLs. This change does not install or save an API key.

See the [official model guide](https://platform.stepfun.com/docs/zh/guides/models/step-5-preview).
