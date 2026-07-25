import { McpApp, Module, ConfigModule } from '@nitrostack/core';
import { EodModule } from './modules/eod/eod.module.js';
import { GitHubModule } from './modules/github/github.module.js';
import { AlertsModule } from './modules/alerts/alerts.module.js';
import { SystemHealthCheck } from './health/system.health.js';

/**
 * GroundTruth — AI agent for EOD-driven team intelligence.
 *
 * Three modules, split by what each is responsible for:
 *   eod     — what employees say they did, plus the agent's review loop
 *   github  — what actually happened, per the GitHub API
 *   alerts  — how the agent escalates to a human
 */
@McpApp({
  module: AppModule,
  server: {
    name: 'groundtruth',
    version: '1.0.0'
  },
  logging: {
    level: 'info'
  }
})
@Module({
  name: 'app',
  description: 'GroundTruth root application module',
  imports: [
    ConfigModule.forRoot(),
    EodModule,
    GitHubModule,
    AlertsModule
  ],
  providers: [
    // Health Checks
    SystemHealthCheck,
  ]
})
export class AppModule {}
