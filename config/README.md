# config/

Local, machine-specific data written by the app. **Everything here except this file and
`accounts.example.json` is git-ignored.**

| File | Created when | Contents |
|---|---|---|
| `accounts.json` | You add your first account | Account URLs, auth method, role, warehouse, and credential *paths*. Never tokens, keys, or passwords. Written `chmod 600`. |
| `audit-log.jsonl` | You execute your first fix | One JSON line per execution: time, account, user, statements, results |
| `accounts.example.json` | Shipped with the repo | Sample input for **Managed accounts → Import JSON** |

Set `SACC_CONFIG_DIR` to keep this data somewhere else.
