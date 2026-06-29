import type { Core } from '@strapi/strapi';
import { runCsvSync } from './sync';

export default {
  /**
   * An asynchronous register function that runs before
   * your application is initialized.
   *
   * This gives you an opportunity to extend code.
   */
  register(/* { strapi }: { strapi: Core.Strapi } */) {},

  /**
   * An asynchronous bootstrap function that runs before
   * your application gets started.
   *
   * This gives you an opportunity to set up your data model,
   * run jobs, or perform some special logic.
   *
   * When SYNC_CSV=true is set in the environment, the CSV importer runs
   * and the process exits with the sync result. Normal startup is unaffected.
   */
  async bootstrap({ strapi }: { strapi: Core.Strapi }) {
    if (process.env.SYNC_CSV === 'true' || process.env.SYNC_CSV === '1') {
      try {
        await runCsvSync(strapi);
        process.exit(0);
      } catch (error: any) {
        console.error('[sync:csv] fatal error:', error.message);
        process.exit(1);
      }
    }
  },
};
