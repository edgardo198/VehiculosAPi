// server.js
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();

// Middlewares
app.use(
  helmet({
    // En dev, permite fetch desde localhost sin CSP estricta
    contentSecurityPolicy: false,
  })
);
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use(morgan('dev'));

// Utilidades
const toInt = (v, def) => {
  const n = Number(v);
  return Number.isInteger(n) ? n : def;
};
const isValidISODate = (s) => {
  // Acepta ISO tipo '2025-09-25T08:00:00.000Z' o '2025-09-25 08:00:00'
  const d = new Date(s);
  return !Number.isNaN(d.getTime());
};

// Home & Health
app.get('/', (_req, res) => {
  res.json({
    name: 'vehiculos-api',
    version: '1.0.0',
    endpoints: ['/health', '/api/vehicles', '/api/movements'],
  });
});
app.get('/health', (_req, res) => res.json({ ok: true }));

// ===== Vehicles CRUD =====

// Listar
app.get('/api/vehicles', async (_req, res, next) => {
  try {
    const items = await prisma.vehicle.findMany({ orderBy: { id: 'desc' } });
    res.json(items);
  } catch (e) {
    next(e);
  }
});

// Obtener por id (útil para editar)
app.get('/api/vehicles/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, null);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    const v = await prisma.vehicle.findUnique({ where: { id } });
    if (!v) return res.status(404).json({ message: 'No encontrado' });
    res.json(v);
  } catch (e) {
    next(e);
  }
});

// Crear
app.post('/api/vehicles', async (req, res, next) => {
  try {
    const { brand, model, plate } = req.body || {};
    if (
      typeof brand !== 'string' ||
      brand.trim() === '' ||
      typeof model !== 'string' ||
      model.trim() === '' ||
      typeof plate !== 'string' ||
      plate.trim() === ''
    ) {
      return res.status(400).json({ message: 'brand, model y plate son obligatorios' });
    }
    const v = await prisma.vehicle.create({
      data: { brand: brand.trim(), model: model.trim(), plate: plate.trim() },
    });
    res.status(201).json(v);
  } catch (e) {
    // Placa única
    if (e.code === 'P2002' && e.meta?.target?.includes('plate')) {
      return res.status(409).json({ message: 'La placa ya existe' });
    }
    next(e);
  }
});

// Actualizar
app.put('/api/vehicles/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, null);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    const { brand, model, plate } = req.body || {};
    const data = {};
    if (brand !== undefined) {
      if (typeof brand !== 'string' || brand.trim() === '') return res.status(400).json({ message: 'brand inválido' });
      data.brand = brand.trim();
    }
    if (model !== undefined) {
      if (typeof model !== 'string' || model.trim() === '') return res.status(400).json({ message: 'model inválido' });
      data.model = model.trim();
    }
    if (plate !== undefined) {
      if (typeof plate !== 'string' || plate.trim() === '') return res.status(400).json({ message: 'plate inválido' });
      data.plate = plate.trim();
    }
    const v = await prisma.vehicle.update({ where: { id }, data });
    res.json(v);
  } catch (e) {
    if (e.code === 'P2002' && e.meta?.target?.includes('plate')) {
      return res.status(409).json({ message: 'La placa ya existe' });
    }
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'No encontrado' });
    }
    next(e);
  }
});

// Eliminar
app.delete('/api/vehicles/:id', async (req, res, next) => {
  try {
    const id = toInt(req.params.id, null);
    if (!id) return res.status(400).json({ message: 'id inválido' });
    await prisma.vehicle.delete({ where: { id } });
    res.status(204).send();
  } catch (e) {
    if (e.code === 'P2025') {
      return res.status(404).json({ message: 'No encontrado' });
    }
    next(e);
  }
});

// ===== Movements (listar con filtros + crear) =====

// Listar con filtros
app.get('/api/movements', async (req, res, next) => {
  try {
    const page = Math.max(1, toInt(req.query.page, 1));
    const pageSize = Math.max(1, Math.min(100, toInt(req.query.pageSize, 10)));
    const vehicleId = req.query.vehicleId ? toInt(req.query.vehicleId, null) : null;
    const driver = req.query.driver ? String(req.query.driver).trim() : null;
    const from = req.query.from ? String(req.query.from) : null;
    const to = req.query.to ? String(req.query.to) : null;

    const where = {};
    if (vehicleId) where.vehicleId = vehicleId;
    if (driver) where.driverName = { contains: driver, mode: 'insensitive' };
    if (from || to) {
      where.dateTime = {};
      if (from) {
        if (!isValidISODate(from)) return res.status(400).json({ message: 'from inválido' });
        where.dateTime.gte = new Date(from);
      }
      if (to) {
        if (!isValidISODate(to)) return res.status(400).json({ message: 'to inválido' });
        where.dateTime.lte = new Date(to);
      }
    }

    const skip = (page - 1) * pageSize;
    const take = pageSize;

    const [items, total] = await Promise.all([
      prisma.movement.findMany({
        where,
        include: { vehicle: true },
        orderBy: { dateTime: 'desc' },
        skip,
        take,
      }),
      prisma.movement.count({ where }),
    ]);

    res.json({ items, total, page, pageSize });
  } catch (e) {
    next(e);
  }
});

// Crear
app.post('/api/movements', async (req, res, next) => {
  try {
    const { vehicleId, driverName, type, dateTime, odometerKm } = req.body || {};
    const vId = toInt(vehicleId, null);
    if (!vId) return res.status(400).json({ message: 'vehicleId inválido' });
    if (typeof driverName !== 'string' || driverName.trim() === '')
      return res.status(400).json({ message: 'driverName requerido' });
    if (type !== 'ENTRY' && type !== 'EXIT') return res.status(400).json({ message: "type debe ser 'ENTRY' o 'EXIT'" });
    if (!isValidISODate(dateTime)) return res.status(400).json({ message: 'dateTime inválido (usa ISO)' });
    const odo = toInt(odometerKm, NaN);
    if (!Number.isInteger(odo) || odo < 0) return res.status(400).json({ message: 'odometerKm inválido' });

    const mv = await prisma.movement.create({
      data: {
        vehicleId: vId,
        driverName: driverName.trim(),
        type,
        dateTime: new Date(dateTime),
        odometerKm: odo,
      },
    });
    res.status(201).json(mv);
  } catch (e) {
    if (e.code === 'P2003') {
      // FK violation (vehicle inexistente)
      return res.status(400).json({ message: 'vehicleId no existe' });
    }
    next(e);
  }
});

// 404 para rutas no definidas
app.use((_req, res, _next) => {
  res.status(404).json({ message: 'No Encontrado' });
});

// Error handler global
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(500).json({ message: 'Internal server error' });
});

// Cierre limpio
process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
process.on('SIGTERM', async () => {
  await prisma.$disconnect();
  process.exit(0);
});

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log(`API running on http://localhost:${PORT}`));
