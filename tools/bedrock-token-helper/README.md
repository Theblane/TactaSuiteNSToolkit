# Bedrock token helper

Lets the NetSuite TactaSuite AI Assistant use **your existing AWS login** instead of a pasted Bedrock API key.

The helper runs on your machine only (127.0.0.1:38790). When the assistant needs to call Bedrock, the extension asks the helper for a short-term Bedrock token, which the helper mints from the AWS credentials already configured here (Identity Center / SSO profile, environment variables, or ~/.aws/credentials). Tokens expire with your AWS session, at most 12 hours. Nothing long-lived is created in AWS and no secret is stored in the browser.

## Run

```
cd tools\bedrock-token-helper
npm install
npm start
```

Or double-click `start-helper.cmd`. Set `AWS_PROFILE` / `AWS_REGION` first to use a different profile or region (defaults: `aws-code-ai`, `us-east-1`). If the AWS session has expired, run `aws sso login --profile aws-code-ai` and start the helper again.

Then in the extension: Settings > AI Assistant > Claude on Amazon Bedrock > **My AWS login (local helper)** > Save > Test.

## Endpoints

- `GET /health` -> `{ ok, profile, region }`
- `GET /token` (header `X-Tacta-Helper: 1`) -> `{ token, expiresAt }`

Only requests from a Chrome extension origin pass the CORS preflight, and the token endpoint requires the custom header, so ordinary web pages cannot read tokens from it.
