import { Context, Next } from 'hono';
import { supabase } from '../Database/DB.js';

export const requireRole = (allowedRoles: ('user' | 'moderator' | 'admin')[]) => {
  return async (c: Context, next: Next) => {
    const jwtPayload = c.get('jwtPayload') as { id: string, email: string };
    
    if (!jwtPayload || !jwtPayload.id) {
      return c.json({ error: 'Unauthorized' }, 401);
    }

    const { data: user, error } = await supabase
      .from('users')
      .select('role')
      .eq('id', jwtPayload.id)
      .single();

    if (error || !user) {
      return c.json({ error: 'User not found' }, 404);
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json({ error: 'Forbidden: Insufficient permissions' }, 403);
    }

    // Attach role to the context for downstream handlers if needed
    c.set('userRole', user.role);

    await next();
  };
};
