import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import bcrypt from 'bcryptjs';
import { supabase } from '../Database/DB.js';

const router = new Hono();

const signupSchema = z.object({
  firstName: z.string().min(1),
  middleInitial: z.string().max(1).optional(),
  lastName: z.string().optional(),
  suffix: z.string().optional(),
  username: z.string().min(3),
  email: z.string().email(),
  password: z.string().min(8),
  birthday: z.string().refine((dateString) => {
    const birthday = new Date(dateString);
    if (isNaN(birthday.getTime())) return false; // Invalid date
    const ageDifMs = Date.now() - birthday.getTime();
    const ageDate = new Date(ageDifMs);
    const age = Math.abs(ageDate.getUTCFullYear() - 1970);
    return age >= 13; // Must be 13 or older
  }, "You must be at least 13 years old to sign up."),
});

router.post('/', zValidator('json', signupSchema), async (c) => {
  const data = c.req.valid('json');

  try {
    // 1. Check if user already exists
    const { data: existingUser } = await supabase
      .from('users')
      .select('id')
      .or(`email.eq.${data.email},username.eq.${data.username}`)
      .single();

    if (existingUser) {
      return c.json({ error: 'Email or Username already taken' }, 400);
    }

    // 2. Hash the password
    const salt = await bcrypt.genSalt(12);
    const hashedPassword = await bcrypt.hash(data.password, salt);

    // 3. Create user
    const { error: createError } = await supabase
      .from('users')
      .insert([{ 
        email: data.email, 
        password_hash: hashedPassword, 
        username: data.username,
        first_name: data.firstName,
        middle_initial: data.middleInitial,
        last_name: data.lastName,
        suffix: data.suffix,
        birthday: data.birthday,
        created_at: new Date().toISOString()
      }]);

    if (createError) {
      console.error('Signup error:', createError);
      return c.json({ error: 'Failed to create account' }, 500);
    }

    return c.json({ message: 'Account created successfully. Please sign in.' }, 201);
  } catch (error) {
    console.error('Signup exception:', error);
    return c.json({ error: 'Internal server error' }, 500);
  }
});

export default router;
