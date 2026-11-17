const express = require('express');
const cors = require('cors');
require('dotenv').config();
const { OpenAI } = require('openai');
const mysql = require('mysql2/promise'); // NUEVO: conexión a MySQL

const app = express();
app.use(express.json());
app.use(cors());

// Inicializar el cliente de OpenAI apuntando a la baseURL de OpenRouter
const openrouter = new OpenAI({
  baseURL: 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY,
  defaultHeaders: {
    'HTTP-Referer': 'https://tu-sitio-web.com', // Opcional: para rankings en OpenRouter
    'X-Title': 'Mi Aplicativo Web',          // Opcional: nombre de tu app
  },
});

// ===========================================================================
// NUEVO: CONEXIÓN A LA BASE DE DATOS (MySQL en WampServer)
// ===========================================================================
const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '', // En WampServer, root normalmente no tiene contraseña
  database: process.env.DB_NAME || 'sakila',
  waitForConnections: true,
  connectionLimit: 5,
  dateStrings: true, // devuelve las fechas tal como están en MySQL, sin convertir zona horaria
});

// ===========================================================================
// NUEVO: HERRAMIENTAS DEL AGENTE (las "manos"): funciones de SOLO LECTURA
// ===========================================================================

// Límite para que la IA no pueda pedir miles de filas
const clamp = (valor, min, max, porDefecto) => {
  const n = Number(valor);
  if (!Number.isFinite(n)) return porDefecto;
  return Math.min(Math.max(Math.trunc(n), min), max);
};

// Pregunta 1: películas largas de una categoría que más se alquilan
async function recomendar_peliculas({ categoria, duracion_minima, limite } = {}) {
  const minutos = clamp(duracion_minima, 0, 600, 120);
  const top = clamp(limite, 1, 20, 3);

  const sql = `
    SELECT f.title AS pelicula,
           c.name AS categoria,
           f.length AS duracion_minutos,
           f.rating AS clasificacion,
           COUNT(r.rental_id) AS veces_alquilada
    FROM film f
    JOIN film_category fc ON fc.film_id = f.film_id
    JOIN category c ON c.category_id = fc.category_id
    JOIN inventory i ON i.film_id = f.film_id
    JOIN rental r ON r.inventory_id = i.inventory_id
    WHERE f.length > ?
      AND (? IS NULL OR c.name = ?)
    GROUP BY f.film_id, f.title, c.name, f.length, f.rating
    ORDER BY veces_alquilada DESC, f.length DESC
    LIMIT ?`;

  const cat = categoria || null;
  const [rows] = await pool.query(sql, [minutos, cat, cat, top]);
  return rows;
}

// Pregunta 2: clientes activos que llevan mucho tiempo sin alquilar
// OJO: Sakila tiene datos de 2005-2006, por eso se compara contra el alquiler
// MÁS RECIENTE de la base y no contra la fecha de hoy.
async function clientes_en_riesgo({ dias_sin_alquilar, limite } = {}) {
  const dias = clamp(dias_sin_alquilar, 1, 3650, 30);
  const top = clamp(limite, 1, 50, 10);

  const sql = `
    SELECT c.customer_id,
           CONCAT(c.first_name, ' ', c.last_name) AS cliente,
           c.email,
           c.store_id AS tienda,
           MAX(r.rental_date) AS ultimo_alquiler,
           DATEDIFF((SELECT MAX(rental_date) FROM rental), MAX(r.rental_date)) AS dias_sin_alquilar,
           COUNT(r.rental_id) AS total_alquileres
    FROM customer c
    JOIN rental r ON r.customer_id = c.customer_id
    WHERE c.active = 1
    GROUP BY c.customer_id, c.first_name, c.last_name, c.email, c.store_id
    HAVING dias_sin_alquilar >= ?
    ORDER BY dias_sin_alquilar DESC
    LIMIT ?`;

  const [rows] = await pool.query(sql, [dias, top]);
  return rows;
}

// Pregunta 3: movimiento y dinero promedio por día de la semana
async function analisis_dia_semana({ tienda_id } = {}) {
  const tienda = tienda_id ? clamp(tienda_id, 1, 1000, null) : null;

  const sql = `
    SELECT DAYNAME(r.rental_date) AS dia_semana,
           COUNT(DISTINCT r.rental_id) AS total_alquileres,
           COUNT(DISTINCT DATE(r.rental_date)) AS dias_con_actividad,
           ROUND(COUNT(DISTINCT r.rental_id) / COUNT(DISTINCT DATE(r.rental_date)), 1) AS alquileres_promedio_por_dia,
           ROUND(SUM(p.amount), 2) AS recaudacion_total,
           ROUND(SUM(p.amount) / COUNT(DISTINCT DATE(r.rental_date)), 2) AS recaudacion_promedio_por_dia
    FROM rental r
    JOIN inventory i ON i.inventory_id = r.inventory_id
    LEFT JOIN payment p ON p.rental_id = r.rental_id
    WHERE (? IS NULL OR i.store_id = ?)
    GROUP BY DAYOFWEEK(r.rental_date), DAYNAME(r.rental_date)
    ORDER BY alquileres_promedio_por_dia DESC`;

  const [rows] = await pool.query(sql, [tienda, tienda]);
  return rows;
}

// Tabla de despacho: nombre que usa la IA -> función real
const funciones = { recomendar_peliculas, clientes_en_riesgo, analisis_dia_semana };

// Ejecuta una herramienta y SIEMPRE devuelve texto (un error también es texto,
// así la IA puede leerlo y explicarlo en lugar de que el servidor se caiga)
async function ejecutarHerramienta(nombre, argumentos) {
  const fn = funciones[nombre];
  if (!fn) return `Herramienta ${nombre} no encontrada.`;
  try {
    const resultado = await fn(argumentos);
    return JSON.stringify(resultado);
  } catch (e) {
    return `Error al consultar la base de datos: ${e.message}`;
  }
}

// ===========================================================================
// NUEVO: EL "MANUAL DE INSTRUCCIONES" PARA LA IA (Tool Schema)
// ===========================================================================
const tools = [
  {
    type: 'function',
    function: {
      name: 'recomendar_peliculas',
      description:
        'Devuelve las películas más alquiladas de la tienda, filtrando por categoría y por duración mínima. ' +
        'Úsala cuando el usuario pida recomendaciones o las películas más populares.',
      parameters: {
        type: 'object',
        properties: {
          categoria: {
            type: 'string',
            description: 'Categoría de la película. Los nombres están en inglés en la base de datos (Action = acción, Comedy = comedia, Horror = terror, etc.).',
            enum: ['Action', 'Animation', 'Children', 'Classics', 'Comedy', 'Documentary', 'Drama', 'Family', 'Foreign', 'Games', 'Horror', 'Music', 'New', 'Sci-Fi', 'Sports', 'Travel'],
          },
          duracion_minima: { type: 'integer', description: 'Duración mínima en MINUTOS. "Más de 2 horas" = 120.' },
          limite: { type: 'integer', description: 'Cuántas películas devolver (por defecto 3).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'clientes_en_riesgo',
      description:
        'Lista los clientes activos que llevan más tiempo sin alquilar ninguna película, es decir, los que están por abandonar el servicio. ' +
        'Los días se miden contra el alquiler más reciente registrado en la base de datos.',
      parameters: {
        type: 'object',
        properties: {
          dias_sin_alquilar: { type: 'integer', description: 'Mínimo de días sin alquilar para considerar al cliente en riesgo (por defecto 30).' },
          limite: { type: 'integer', description: 'Cuántos clientes devolver (por defecto 10).' },
        },
        required: [],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'analisis_dia_semana',
      description:
        'Analiza el movimiento de las tiendas por día de la semana: cantidad de alquileres y dinero recaudado en total y en promedio por día. ' +
        'Los nombres de los días vienen en inglés. ' +
        'Para decidir qué día tiene más movimiento, compara el promedio por día y no el total, porque algunos días tienen más semanas de datos.',
      parameters: {
        type: 'object',
        properties: {
          tienda_id: { type: 'integer', description: 'Opcional. Número de tienda (1 o 2). Si se omite, se analizan todas las tiendas.' },
        },
        required: [],
      },
    },
  },
];

// ===========================================================================
// ENDPOINT DEL CHAT
// ===========================================================================
app.post('/api/chat', async (req, res) => {
  try {
    const { message, history } = req.body;

    // NUEVO: instrucciones del agente (equivale al mensaje "system" de la Práctica 1)
    const systemPrompt = {
      role: 'system',
      content:
        'Eres un asistente de una tienda de alquiler de películas. Respondes siempre en español. ' +
        'Tienes herramientas que consultan la base de datos real de la tienda (Sakila). ' +
        'Para cualquier pregunta sobre películas, clientes, alquileres o ingresos, USA las herramientas y nunca inventes datos. ' +
        'Presenta los resultados de forma clara y agrega una breve conclusión. ' +
        'Los nombres de categorías y de días vienen en inglés en la base de datos; tradúcelos al español al responder. ' +
        'No uses formato Markdown; usa texto plano con guiones para las listas. ' +
        'Si el usuario solo conversa o saluda, responde normal sin usar herramientas.',
    };

    // Construir el arreglo de mensajes combinando historial y mensaje actual
    const messages = [systemPrompt, ...(history || []), { role: 'user', content: message }];

    // NUEVO: bucle del agente (máximo 6 vueltas para evitar un ciclo infinito)
    let reply = '';
    for (let vuelta = 1; vuelta <= 6; vuelta++) {

      // Llamada a la API a través de OpenRouter
      const completion = await openrouter.chat.completions.create({
        model: 'openai/gpt-4o-mini', // Puedes cambiarlo por cualquier modelo soportado por OpenRouter
        messages: messages,
        tools: tools, // NUEVO: le presentamos las herramientas a la IA
      });

      const respuestaIA = completion.choices[0].message;
      messages.push(respuestaIA); // NUEVO: guardamos la respuesta en la memoria

      // NUEVO: ¿la IA decidió usar una herramienta?
      if (respuestaIA.tool_calls && respuestaIA.tool_calls.length > 0) {
        for (const toolCall of respuestaIA.tool_calls) {
          const nombre = toolCall.function.name;

          // La IA envía los parámetros como texto; los convertimos a objeto
          let argumentos = {};
          try {
            argumentos = JSON.parse(toolCall.function.arguments || '{}');
          } catch (e) {
            argumentos = {};
          }

          console.log(`\n[Vuelta ${vuelta}] La IA decidió usar: ${nombre}`);
          console.log('Argumentos que envió:', argumentos);

          // Ejecutamos la función real contra la base de datos
          const resultado = await ejecutarHerramienta(nombre, argumentos);
          console.log('Resultado (primeros 200 caracteres):', resultado.slice(0, 200));

          // Le devolvemos el resultado a la IA para la siguiente vuelta
          messages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultado,
          });
        }
      } else {
        // Si NO pidió herramientas, terminó: esta es la respuesta final
        reply = respuestaIA.content;
        break;
      }
    }

    // NUEVO: por si se agotaron las vueltas sin respuesta final
    if (!reply) {
      reply = 'Lo siento, no pude completar la consulta. Intenta reformular la pregunta.';
    }

    res.json({ reply });
  } catch (error) {
    console.error('Error al comunicarse con OpenRouter:', error);
    res.status(500).json({ error: 'Error interno al procesar la solicitud con la IA' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor corriendo en puerto ${PORT}`);
});