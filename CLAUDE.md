# CLAUDE.md -- DiDo for Blockscout

Instructions for any AI/agent session working on this repo.

## What this is

A **public** hackathon entry (Blockscout PRO API Buildathon, Oct 8 - Nov 3
2026): a token's holder map and wallet clusters, built entirely on the
Blockscout PRO API. It is a stand-alone project, separate from DigitalDon's
private monorepo and from the DiDo that ships there. Nothing here is read by
DigitalDon and nothing flows back automatically.

## Rules

- **Public repo.** Never commit an API key, a `.env`, internal hostnames, or
  anything from DigitalDon's private code that is not meant to be public.
  Write the code here fresh; do not paste the private bot's source.
- **Blockscout is the only data source.** Judging weights the Blockscout
  integration at 30%, and the pitch is "every number comes from Blockscout".
  Do not add another data provider.
- **Never log the API key.** It travels as a query parameter, so never log or
  return a request URL as-is.
- **"Absent" is not "error".** Keep the client's `ok / absent / error`
  distinction all the way to the UI; an outage must never render as "no
  holders" or "no clusters".
- **Respect the rate gate.** Every request goes through `BlockscoutClient`;
  never call `fetch` on Blockscout directly.
- **Brand is monochrome** (ink on paper, emphasis by opacity), as in
  DigitalDon. The cluster tints are the only colour.
- Run `npm test` before every push. Bump `VERSION` and `package.json` together.
