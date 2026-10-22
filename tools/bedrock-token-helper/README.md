# Bedrock token helper

Lets the NetSuite TactaSuite AI Assistant call Claude on Amazon Bedrock with **your own AWS identity**, with no long-lived key anywhere.

The helper runs on your machine only (127.0.0.1:38790). From the extension's Settings page you enter your IAM Identity Center details (start URL, SSO region, account id, role name, scopes), click **Sign in with AWS**, and approve the sign-in in the browser tab that opens (Okta, or whatever your identity provider is). From then on the helper exchanges that session for temporary role credentials and mints short-term Bedrock API keys on demand. Tokens expire with the AWS session, at most 12 hours. Nothing long-lived is created in AWS and no secret is stored in the browser.

It can also reuse an **AWS CLI profile** that is already signed in on this computer (mode "Use an AWS CLI profile"), and it can import the Identity Center details from `~/.aws/config` so you do not have to type them.

## Run

```
cd tools\bedrock-token-helper
npm install
npm start
```

Or double-click `start-helper.cmd`. Leave the window open while you use the assistant. Set `TACTA_HELPER_PORT` to change the port.

Then in the extension: Settings > AI Assistant > Claude on Amazon Bedrock > **My AWS login (local helper)**.

## Where things are stored

`%USERPROFILE%\.tactasuite\`: `bedrock-helper.json` (your Identity Center details), `sso-client.json` (the helper's OIDC client registration) and `sso-token.json` (the current AWS access token). Delete the folder to reset.

## Endpoints

All except `/health` require the header `X-Tacta-Helper: 1`; cross-origin preflights are only granted to `chrome-extension://` origins, so ordinary web pages cannot use it.

- `GET /health` -> mode, configured, signedIn, sessionExpiresAt
- `GET /config` / `POST /config` -> the Identity Center details (+ importable CLI profiles)
- `POST /login` -> starts the device-authorization sign-in, returns the verification URL
- `GET /login/status` -> pending | ok | error
- `POST /logout`
- `GET /token` -> `{ token, expiresAt }` short-term Bedrock API key
