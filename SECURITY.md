# Security Policy

## Scope

Placement Helper automates the signed-in user's own university placement workflow. It must not be used to access another student's account, bypass authentication, defeat anti-automation controls, or overload the portal.

## Reporting a vulnerability

Please use this repository's **Security → Report a vulnerability** workflow. Do not post session cookies, student data, credentials, portal responses, or exploit details in a public issue.

A useful report includes the affected component, sanitized reproduction steps, expected behavior, observed behavior, and impact.

## Sensitive data

The following must never be committed or included in diagnostics:

- UMS session cookies or credentials;
- `.env` files containing real values;
- PostHog or other analytics credentials;
- fetched student or placement data;
- local Electron user-data directories.

## Desktop security assumptions

- Keep Electron `contextIsolation` enabled and `nodeIntegration` disabled for renderer content.
- Expose only narrow, validated methods through the preload context bridge.
- Validate IPC arguments and external URLs in the main process.
- Store session material using OS-protected storage in production.
- Require explicit user confirmation before drive registration.

## Responsible use

Use the app only with your own account and in accordance with the portal's terms. Rate-limit automated requests and stop if the portal indicates that automation is not permitted.
