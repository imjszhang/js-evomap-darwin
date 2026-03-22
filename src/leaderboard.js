/**
 * Aggregates fitness data by (model, taskType) dimensions.
 * Provides leaderboard views for token suppliers and dashboard visualization.
 *
 * Wraps FitnessTracker — no separate persistence, all derived from tracker data.
 */
export class Leaderboard {
  #tracker;

  constructor({ fitnessTracker }) {
    this.#tracker = fitnessTracker;
  }

  /**
   * Get the model performance leaderboard for a specific task type.
   * If taskType is omitted, aggregates across all tasks.
   */
  getLeaderboard(taskType) {
    return this.#tracker.rankByModel(taskType);
  }

  /**
   * Get leaderboards for every observed task type.
   * Returns { taskType -> ranking[] }.
   */
  getAllLeaderboards() {
    const taskTypes = this.#collectTaskTypes();
    const result = {};
    for (const tt of taskTypes) {
      const ranking = this.#tracker.rankByModel(tt);
      if (ranking.length > 0) {
        result[tt] = ranking;
      }
    }
    result._all = this.#tracker.rankByModel();
    return result;
  }

  /**
   * Generate a report for a specific sponsor — how their model performs
   * vs competitors across all task types.
   */
  getSponsorReport(sponsorModel) {
    const allBoards = this.getAllLeaderboards();
    const report = { model: sponsorModel, taskTypes: {} };

    for (const [taskType, rankings] of Object.entries(allBoards)) {
      const own = rankings.find((r) => r.model === sponsorModel);
      if (!own) continue;
      const rank = rankings.indexOf(own) + 1;
      report.taskTypes[taskType] = {
        rank,
        totalCompetitors: rankings.length,
        avgFitness: own.avgFitness,
        successRate: own.successRate,
        avgTokens: own.avgTokens,
        samples: own.samples,
      };
    }

    return report;
  }

  /**
   * Collect all unique task types from the tracker.
   */
  #collectTaskTypes() {
    const ranked = this.#tracker.rankAll();
    const types = new Set();
    for (const r of ranked) {
      if (r.taskTypes) {
        for (const t of r.taskTypes) types.add(t);
      }
    }
    return [...types];
  }
}
