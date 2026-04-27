import { Hono } from 'hono';
import { supabase } from '../Database/DB.js';
import { authMiddleware } from '../Middleware/Auth.js';
import { requireRole } from '../Middleware/RBAC.js';

const app = new Hono();

app.use('*', authMiddleware);
app.use('*', requireRole(['admin', 'moderator']));

app.get('/stats', async (c) => {
  // Simple stats for the dashboard
  
  // Total users
  const { count: usersCount } = await supabase
    .from('users')
    .select('*', { count: 'exact', head: true });

  // Total comments
  const { count: commentsCount } = await supabase
    .from('comments')
    .select('*', { count: 'exact', head: true });

  // Analytics points (mocked daily active users or page views for recharts)
  const { data: analyticsData } = await supabase
    .from('site_analytics')
    .select('created_at, event_type')
    .order('created_at', { ascending: false })
    .limit(100);

  // Group analytics by day for chart
  const groupedStats: Record<string, number> = {};
  if (analyticsData) {
    analyticsData.forEach(event => {
      const date = new Date(event.created_at).toISOString().split('T')[0];
      groupedStats[date] = (groupedStats[date] || 0) + 1;
    });
  }
  
  const chartData = Object.entries(groupedStats).map(([date, views]) => ({ date, views })).reverse();

  return c.json({
    totalUsers: usersCount || 0,
    totalComments: commentsCount || 0,
    chartData: chartData.length > 0 ? chartData : [
      { date: new Date().toISOString().split('T')[0], views: 1 } // Fallback safe data
    ]
  });
});

export default app;
