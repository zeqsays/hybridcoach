// api/generate-week.js — Vercel Cron Job
// Se ejecuta todos los domingos a las 23:59 ART (02:59 UTC lunes)
// Lee sensaciones de la semana → genera la siguiente con Claude → guarda en Supabase

import { createClient } from '@supabase/supabase-js';

const sb = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY // service key para acceso admin
);

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

export default async function handler(req, res) {
  // Verificar que es llamada del cron de Vercel (o llamada manual autorizada)
  const authHeader = req.headers.authorization;
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log('generate-week cron started:', new Date().toISOString());

  try {
    // 1. Obtener todos los usuarios activos con su semana actual
    const { data: profiles, error: profilesError } = await sb
      .from('profiles')
      .select('id, email, current_week')
      .not('current_week', 'is', null);

    if (profilesError) throw profilesError;
    console.log(`Processing ${profiles.length} users`);

    const results = [];

    for (const profile of profiles) {
      try {
        const result = await generateNextWeekForUser(profile);
        results.push({ user: profile.email, ...result });
      } catch (e) {
        console.error(`Error for user ${profile.email}:`, e.message);
        results.push({ user: profile.email, error: e.message });
      }
    }

    return res.status(200).json({ success: true, processed: results.length, results });

  } catch (error) {
    console.error('Cron error:', error);
    return res.status(500).json({ error: error.message });
  }
}

async function generateNextWeekForUser(profile) {
  const currentWeek = profile.current_week;
  const nextWeek = currentWeek + 1;

  // Verificar que la semana siguiente no existe ya
  const { data: existing } = await sb
    .from('weeks')
    .select('id')
    .eq('user_id', profile.id)
    .eq('week_number', nextWeek)
    .maybeSingle();

  if (existing) {
    return { status: 'skipped', reason: `Week ${nextWeek} already exists` };
  }

  // 1. Obtener datos de la semana actual
  const { data: currentWeekData } = await sb
    .from('weeks')
    .select('week_data, label, date_start, date_end')
    .eq('user_id', profile.id)
    .eq('week_number', currentWeek)
    .single();

  if (!currentWeekData) {
    return { status: 'skipped', reason: 'No current week data found' };
  }

  // 2. Obtener todos los logs de sensaciones de la semana actual
  const { data: logs } = await sb
    .from('daily_logs')
    .select('day_index, session_index, completed, sensations')
    .eq('user_id', profile.id)
    .eq('week_number', currentWeek);

  // 3. Obtener perfil del atleta para contexto
  const { data: onboarding } = await sb
    .from('athlete_onboarding')
    .select('raw_input, objetivo, nivel, lesiones, disponibilidad, equipamiento')
    .eq('athlete_id', profile.id)
    .maybeSingle();

  // 4. Calcular métricas de la semana
  const weekSummary = buildWeekSummary(currentWeekData, logs);

  // 5. Calcular fechas de la próxima semana
  const nextDateStart = new Date(currentWeekData.date_end);
  nextDateStart.setDate(nextDateStart.getDate() + 1);
  const nextDateEnd = new Date(nextDateStart);
  nextDateEnd.setDate(nextDateEnd.getDate() + 6);

  const formatDate = d => d.toISOString().split('T')[0];

  // 6. Generar semana con Claude
  const prompt = buildGenerationPrompt(
    profile.email,
    currentWeek,
    nextWeek,
    currentWeekData,
    weekSummary,
    onboarding,
    formatDate(nextDateStart),
    formatDate(nextDateEnd)
  );

  const aiResponse = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!aiResponse.ok) {
    throw new Error(`Claude API error: ${aiResponse.status}`);
  }

  const aiData = await aiResponse.json();
  const aiText = aiData.content?.[0]?.text || '';

  // 7. Parsear el JSON de la semana generada
  const weekData = parseWeekJSON(aiText);
  if (!weekData) throw new Error('Failed to parse generated week JSON');

  // 8. Guardar en Supabase
  const { error: insertError } = await sb.from('weeks').insert({
    user_id: profile.id,
    week_number: nextWeek,
    label: `S${nextWeek} · ${formatDate(nextDateStart).slice(5).replace('-', ' ')} – ${formatDate(nextDateEnd).slice(5).replace('-', ' ')}`,
    date_start: formatDate(nextDateStart),
    date_end: formatDate(nextDateEnd),
    week_data: weekData,
  });

  if (insertError) throw insertError;

  // 9. Actualizar current_week del perfil
  await sb.from('profiles')
    .update({ current_week: nextWeek })
    .eq('id', profile.id);

  return {
    status: 'generated',
    week: nextWeek,
    dateStart: formatDate(nextDateStart),
    dateEnd: formatDate(nextDateEnd),
  };
}

function buildWeekSummary(weekData, logs) {
  const WEEK = weekData.week_data || [];
  let totalEx = 0, doneEx = 0;
  const sessionSummaries = [];

  WEEK.forEach((day, di) => {
    if (!day.sessions) return;
    day.sessions.forEach((sess, si) => {
      const log = logs?.find(l => l.day_index === di && l.session_index === si);
      const exCount = sess.exercises?.length || 0;
      const completed = log?.completed ? Object.values(log.completed).filter(Boolean).length : 0;
      totalEx += exCount;
      doneEx += completed;
      if (log?.sensations && Object.keys(log.sensations).length > 0) {
        sessionSummaries.push({
          day: day.label,
          session: sess.tagLabel,
          completed: `${completed}/${exCount}`,
          ...log.sensations,
        });
      }
    });
  });

  const completionPct = totalEx > 0 ? Math.round((doneEx / totalEx) * 100) : 0;
  return { completionPct, totalEx, doneEx, sessionSummaries };
}

function buildGenerationPrompt(email, currentWeek, nextWeek, currentWeekData, summary, onboarding, dateStart, dateEnd) {
  const sensationsText = summary.sessionSummaries.length > 0
    ? summary.sessionSummaries.map(s =>
        `${s.day} · ${s.session}: ${s.completed} completados | energía: ${s.energy||'?'} | fatiga muscular: ${s.muscle||'?'} | mental: ${s.mood||'?'} | dolor: ${s.pain||'?'}${s.text ? ` | notas: ${s.text}` : ''}`
      ).join('\n')
    : 'Sin sensaciones registradas esta semana.';

  const profileText = onboarding
    ? `Objetivo: ${onboarding.objetivo || 'no especificado'} | Nivel: ${onboarding.nivel || 'no especificado'} | Lesiones: ${onboarding.lesiones || 'ninguna'} | Disponibilidad: ${onboarding.disponibilidad || 'no especificado'} | Equipamiento: ${onboarding.equipamiento || 'no especificado'}`
    : 'Atleta híbrido · Triatlón IRONMAN 5051 octubre 2026 · Calistenia + running + bici + natación';

  return `Sos el motor de HybridCoach AI. Tu tarea es generar la Semana ${nextWeek} de entrenamiento para este atleta basándote en los datos de la Semana ${currentWeek}.

PERFIL DEL ATLETA:
${profileText}

RESUMEN SEMANA ${currentWeek} (${currentWeekData.label}):
- Completado: ${summary.doneEx}/${summary.totalEx} ejercicios (${summary.completionPct}%)
- Sensaciones por sesión:
${sensationsText}

REGLAS DE AJUSTE:
- Si completó >80% y energía/fatiga fueron buenas → aumentar volumen 8–10%
- Si completó 60–80% o fatiga media → mantener volumen, ajustar intensidad
- Si completó <60% o fatiga alta → reducir volumen 15–20%, mantener frecuencia
- Si reportó dolor en alguna zona → eliminar ejercicios que la comprometan, agregar preventivos
- Si abandonó días → no aumentar volumen, revisar disponibilidad
- Respetar siempre: 15 min movilidad antes de cada sesión, no fuerza inferior el mismo día que running largo, al menos 1 día descanso completo
- TTB máximo 2 sesiones por semana con al menos 1 día de separación
- Superseries solo en los últimos 4 ejercicios de cada sesión de fuerza
- Semana del ${dateStart} al ${dateEnd}

Respondé SOLO con el JSON del array de 7 días, sin texto adicional, sin markdown:

[
  {
    "day": "Lun", "date": ${new Date(dateStart).getDate()}, "label": "Lunes ${new Date(dateStart).getDate()} ${['ene','feb','mar','abr','may','jun','jul','ago','sep','oct','nov','dic'][new Date(dateStart).getMonth()]}",
    "sessions": [
      {
        "time": "AM", "tag": "str", "tagLabel": "Superior — empuje",
        "exercises": [
          {"ico": "act", "name": "Movilidad pre-sesión", "meta": "15 min", "hint": "Dinámica general"}
        ]
      }
    ]
  }
]

Valores válidos para "ico": act, run, bike, swim, str, exp, iso, prev, hip, knee, core
Para días de descanso: {"day": "Dom", "date": X, "label": "...", "rest": true, "sessions": []}`;
}

function parseWeekJSON(text) {
  try {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed;
  } catch (e) {
    console.error('Parse error:', e);
    return null;
  }
}
