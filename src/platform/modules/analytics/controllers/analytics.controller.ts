import { AnalyticsService } from '../services/analytics.service';

const service = new AnalyticsService();

export const analyticsController = {
  dashboard: async () => service.dashboard()
};
