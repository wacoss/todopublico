import { buildPushPayload } from '@pushforge/builder';

function normalizarRuta(pathname) {
  return pathname.replace(/\/{2,}/g, '/');
}

function cors(request) {
  const origin = request.headers.get('Origin') || '*';

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Content-Type': 'application/json; charset=UTF-8'
  };
}

function respuesta(data, request, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: cors(request)
  });
}

function fechaLocalChileISO() {
  const partes = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Santiago',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const obtener = (tipo) => partes.find(p => p.type === tipo).value;

  return `${obtener('year')}-${obtener('month')}-${obtener('day')}`;
}

async function enviarPush(subscription, payload, env) {
  const builder = new PushBuilder({
    subject: `mailto:${env.CONTACT_EMAIL}`,
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY
  });

  const request = await builder
    .setSubscription(subscription)
    .setPayload(JSON.stringify(payload))
    .build();

  return fetch(subscription.endpoint, request);
}

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);
    const path = normalizarRuta(requestUrl.pathname);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request) });
    }

    if (!env.TODO_KV) {
      return respuesta({
        ok: false,
        error: 'Falta el binding KV TODO_KV.'
      }, request, 500);
    }

    if (path === '/' && request.method === 'GET') {
      return respuesta({
        ok: true,
        service: 'To Do Push Worker',
        pathReceived: requestUrl.pathname,
        normalizedPath: path,
        kvBindingAvailable: true,
        endpoints: [
          'GET /api/health',
          'POST /api/subscribe',
          'POST /api/reminders'
        ]
      }, request);
    }

    if (path === '/api/health' && request.method === 'GET') {
      try {
        await env.TODO_KV.list({ prefix: '__healthcheck__', limit: 1 });

        return respuesta({
          ok: true,
          kvBindingAvailable: true,
          normalizedPath: path
        }, request);
      } catch (error) {
        return respuesta({
          ok: false,
          error: error.message
        }, request, 500);
      }
    }

    if (path === '/api/subscribe' && request.method === 'POST') {
      try {
        const body = await request.json();
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';

        if (!userId || !body.subscription?.endpoint) {
          return respuesta({
            ok: false,
            error: 'Se requieren userId y subscription.endpoint.'
          }, request, 400);
        }

        await env.TODO_KV.put(
          `sub:${userId}`,
          JSON.stringify(body.subscription)
        );

        console.log(JSON.stringify({
          event: 'subscription_saved',
          userId,
          pathReceived: requestUrl.pathname,
          normalizedPath: path
        }));

        return respuesta({
          ok: true,
          saved: `sub:${userId}`
        }, request);
      } catch (error) {
        console.error('subscribe_error', error);

        return respuesta({
          ok: false,
          error: error.message
        }, request, 500);
      }
    }

    if (path === '/api/reminders' && request.method === 'POST') {
      try {
        const body = await request.json();
        const userId = typeof body.userId === 'string' ? body.userId.trim() : '';
        const reminders = Array.isArray(body.reminders) ? body.reminders : [];

        if (!userId) {
          return respuesta({
            ok: false,
            error: 'userId requerido.'
          }, request, 400);
        }

        const normalizedReminders = reminders
          .filter(item =>
            item &&
            typeof item.id === 'string' &&
            typeof item.fecha === 'string'
          )
          .map(item => ({
            id: item.id,
            tarea: typeof item.tarea === 'string'
              ? item.tarea.trim() || 'Nueva tarea'
              : 'Nueva tarea',
            nota: typeof item.nota === 'string' ? item.nota.trim() : '',
            fecha: item.fecha,
            notificado: false
          }));

        await env.TODO_KV.put(
          `reminders:${userId}`,
          JSON.stringify(normalizedReminders)
        );

        console.log(JSON.stringify({
          event: 'reminders_saved',
          userId,
          total: normalizedReminders.length
        }));

        return respuesta({
          ok: true,
          saved: `reminders:${userId}`,
          count: normalizedReminders.length
        }, request);
      } catch (error) {
        console.error('reminders_error', error);

        return respuesta({
          ok: false,
          error: error.message
        }, request, 500);
      }
    }

    return respuesta({
      ok: false,
      error: 'Ruta o método no encontrado.',
      method: request.method,
      pathReceived: requestUrl.pathname,
      normalizedPath: path
    }, request, 404);
  },

  async scheduled(event, env, ctx) {
    if (!env.TODO_KV) {
      console.error('scheduled_error: falta el binding TODO_KV');
      return;
    }

    const fechaHoy = fechaLocalChileISO();
    const resultado = await env.TODO_KV.list({ prefix: 'reminders:' });

    console.log(JSON.stringify({
      event: 'cron_started',
      cron: event.cron,
      fechaHoy,
      reminderListsFound: resultado.keys.length
    }));

    for (const clave of resultado.keys) {
      const userId = clave.name.replace('reminders:', '');

      const [recordatoriosRaw, subscriptionRaw] = await Promise.all([
        env.TODO_KV.get(clave.name),
        env.TODO_KV.get(`sub:${userId}`)
      ]);

      if (!recordatoriosRaw || !subscriptionRaw) {
        console.warn(`No hay suscripción o recordatorios para ${userId}`);
        continue;
      }

      let recordatorios;
      let subscription;

      try {
        recordatorios = JSON.parse(recordatoriosRaw);
        subscription = JSON.parse(subscriptionRaw);
      } catch (error) {
        console.error(`JSON inválido para ${userId}`, error);
        continue;
      }

      let huboCambios = false;

      for (const tarea of recordatorios) {
        if (tarea.fecha !== fechaHoy || tarea.notificado) {
          continue;
        }

        try {
          const response = await enviarPush(subscription, {
            title: 'Recordatorio de tarea',
            body: tarea.nota
              ? `${tarea.tarea} — ${tarea.nota}`
              : tarea.tarea,
            url: '/'
          }, env);

          if (response.ok || response.status === 201) {
            tarea.notificado = true;
            huboCambios = true;

            console.log(JSON.stringify({
              event: 'push_sent',
              userId,
              taskId: tarea.id,
              status: response.status
            }));
          } else {
            const responseText = await response.text();

            console.error(JSON.stringify({
              event: 'push_failed',
              userId,
              taskId: tarea.id,
              status: response.status,
              response: responseText
            }));

            // Suscripción expirada o inválida.
            if (response.status === 404 || response.status === 410) {
              await env.TODO_KV.delete(`sub:${userId}`);
            }
          }
        } catch (error) {
          console.error(JSON.stringify({
            event: 'push_error',
            userId,
            taskId: tarea.id,
            error: error.message
          }));
        }
      }

      if (huboCambios) {
        await env.TODO_KV.put(clave.name, JSON.stringify(recordatorios));
      }
    }
  }
};
