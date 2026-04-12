# 🚀 Getting started with Strapi

Strapi comes with a full featured [Command Line Interface](https://docs.strapi.io/dev-docs/cli) (CLI) which lets you scaffold and manage your project in seconds.

### `develop`

Start your Strapi application with autoReload enabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-develop)

```
npm run develop
# or
yarn develop
```

### `start`

Start your Strapi application with autoReload disabled. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-start)

```
npm run start
# or
yarn start
```

### `build`

Build your admin panel. [Learn more](https://docs.strapi.io/dev-docs/cli#strapi-build)

```
npm run build
# or
yarn build
```

### `sync:csv`

Upload CSV-backed data into Strapi and connect related records (replicates `uploader.ipynb`).
The command automatically reads `.env` and `.env.local` from the project root.

```bash
npm run sync:csv
```

Optional variants:

```bash
# Delete only records represented by CSV files, then import + reconnect
npm run sync:csv:delete

# Delete only records represented by CSV files (no import)
npm run sync:csv:delete-only

# Re-run relation linking only (no delete/import)
npm run sync:csv -- --relations-only

# Relation linking in smaller batches (safer for SQLite)
npm run sync:csv -- --relation-batch-size=100

# Optional cap for relation source rows while testing
npm run sync:csv -- --relations-only --limit-relations=1000
```

Optional environment variables:

- `STRAPI_URL` (default: `http://localhost:1337`)
- `CSV_DIR` (default: `./data/csv`)
- `STRAPI_API_TOKEN` (or `API_KEY`)
- `RELATION_BATCH_SIZE` (default: `500`)
- `RELATION_LIMIT` (optional)

### `dedupe:strapi`

Remove duplicate records directly in Strapi for CSV-backed collections (not CSV files).
Duplicates are grouped by stable key fields (for example `maker_id`, `address_id`, `town_location_id`).

```bash
# Preview only
npm run dedupe:strapi:dry

# Apply deletions
npm run dedupe:strapi

# Limit to specific collections
npm run dedupe:strapi -- --collections=makers,town-locations

# Write an audit report (default path: ./reports/dedupe-strapi-<timestamp>.json)
npm run dedupe:strapi -- --json-report

# Write report to a custom path
npm run dedupe:strapi -- --json-report=./reports/dedupe-latest.json
```

After applying dedupe, re-run relation linking:

```bash
npm run sync:csv -- --relations-only
```

### `dedupe:sqlite`

Deduplicate directly in the SQLite database file (bypasses Strapi API visibility/pagination differences).
This mode also rewires relation/link-table references to kept records before deleting duplicates.

```bash
# Preview only (transaction rollback)
npm run dedupe:sqlite:dry

# Apply database-level dedupe
npm run dedupe:sqlite

# Limit to specific collections
npm run dedupe:sqlite -- --collections=makers,town-locations

# Write JSON report
npm run dedupe:sqlite -- --json-report=./reports/dedupe-sqlite-latest.json
```

Defaults to `DATABASE_FILENAME` from `.env` (or `./.tmp/data.db`).

## ⚙️ Deployment

Strapi gives you many possible deployment options for your project including [Strapi Cloud](https://cloud.strapi.io). Browse the [deployment section of the documentation](https://docs.strapi.io/dev-docs/deployment) to find the best solution for your use case.

```
yarn strapi deploy
```

## 📚 Learn more

- [Resource center](https://strapi.io/resource-center) - Strapi resource center.
- [Strapi documentation](https://docs.strapi.io) - Official Strapi documentation.
- [Strapi tutorials](https://strapi.io/tutorials) - List of tutorials made by the core team and the community.
- [Strapi blog](https://strapi.io/blog) - Official Strapi blog containing articles made by the Strapi team and the community.
- [Changelog](https://strapi.io/changelog) - Find out about the Strapi product updates, new features and general improvements.

Feel free to check out the [Strapi GitHub repository](https://github.com/strapi/strapi). Your feedback and contributions are welcome!

## ✨ Community

- [Discord](https://discord.strapi.io) - Come chat with the Strapi community including the core team.
- [Forum](https://forum.strapi.io/) - Place to discuss, ask questions and find answers, show your Strapi project and get feedback or just talk with other Community members.
- [Awesome Strapi](https://github.com/strapi/awesome-strapi) - A curated list of awesome things related to Strapi.

---

<sub>🤫 Psst! [Strapi is hiring](https://strapi.io/careers).</sub>
