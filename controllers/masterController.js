const prisma = require('../config/prisma');
const { sendSuccess, sendError } = require('../utils/response');
const logger = require('../services/logger');
const { sendPushNotification } = require('../services/notificationService');

const sseClients = new Set();

const registerSSEClient = (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.flushHeaders();

  const client = { res };
  sseClients.add(client);

  const heartbeat = setInterval(() => {
    res.write(':heartbeat\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(heartbeat);
    sseClients.delete(client);
  });
};

const broadcastMasterUpdate = (event, data) => {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    try {
      client.res.write(payload);
    } catch {
      sseClients.delete(client);
    }
  }
};

const notifyAllUsers = async (title, body, data) => {
  try {
    const devices = await prisma.deviceToken.findMany({ select: { token: true } });
    const tokens = [...new Set(devices.map(d => d.token))];
    if (tokens.length > 0) {
      await sendPushNotification(tokens, title, body, data);
    }
  } catch (err) {
    logger.error('[Master] FCM notify failed', { error: err.message });
  }
};

const getAll = async (req, res) => {
  try {
    const [categories, buildings, lfCategories] = await Promise.all([
      prisma.category.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
        include: {
          subCategories: {
            where: { isActive: true },
            orderBy: { displayOrder: 'asc' },
          },
        },
      }),
      prisma.building.findMany({
        where: { isActive: true },
        include: {
          floors: { where: { isActive: true }, orderBy: { floorNumber: 'asc' } },
          rooms: { where: { isActive: true }, orderBy: { roomNumber: 'asc' } },
        },
      }),
      prisma.lostFoundCategory.findMany({
        where: { isActive: true },
        orderBy: { displayOrder: 'asc' },
      }),
    ]);

    sendSuccess(res, { categories, buildings, lfCategories });
  } catch (err) {
    sendError(res, err.message);
  }
};

const getAllAdmin = async (req, res) => {
  try {
    const [categories, buildings, lfCategories] = await Promise.all([
      prisma.category.findMany({
        orderBy: { displayOrder: 'asc' },
        include: {
          subCategories: { orderBy: { displayOrder: 'asc' } },
        },
      }),
      prisma.building.findMany({
        include: {
          floors: { orderBy: { floorNumber: 'asc' } },
          rooms: { orderBy: { roomNumber: 'asc' } },
        },
      }),
      prisma.lostFoundCategory.findMany({ orderBy: { displayOrder: 'asc' } }),
    ]);

    sendSuccess(res, { categories, buildings, lfCategories });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createCategory = async (req, res) => {
  try {
    const { name, iconName, color, designation, displayOrder } = req.body;
    if (!name || !iconName || !color) return sendError(res, 'name, iconName, color are required', 400);

    const category = await prisma.category.create({
      data: { name, iconName, color, designation: designation || null, displayOrder: displayOrder ?? 0 },
    });

    broadcastMasterUpdate('category_created', category);
    sendSuccess(res, { category });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, iconName, color, designation, displayOrder, isActive } = req.body;

    const category = await prisma.category.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(iconName !== undefined && { iconName }),
        ...(color !== undefined && { color }),
        ...(designation !== undefined && { designation }),
        ...(displayOrder !== undefined && { displayOrder }),
        ...(isActive !== undefined && { isActive }),
      },
      include: { subCategories: { orderBy: { displayOrder: 'asc' } } },
    });

    broadcastMasterUpdate('category_updated', category);
    sendSuccess(res, { category });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteCategory = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.category.delete({ where: { id } });
    broadcastMasterUpdate('category_deleted', { id });
    sendSuccess(res, { message: 'Category deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createSubCategory = async (req, res) => {
  try {
    const { categoryId, name, displayOrder } = req.body;
    if (!categoryId || !name) return sendError(res, 'categoryId and name are required', 400);

    const sub = await prisma.subCategory.create({
      data: { categoryId, name, displayOrder: displayOrder ?? 0 },
    });

    broadcastMasterUpdate('subcategory_created', sub);
    sendSuccess(res, { sub });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateSubCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, displayOrder, isActive } = req.body;

    const sub = await prisma.subCategory.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(displayOrder !== undefined && { displayOrder }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    broadcastMasterUpdate('subcategory_updated', sub);
    sendSuccess(res, { sub });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteSubCategory = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.subCategory.delete({ where: { id } });
    broadcastMasterUpdate('subcategory_deleted', { id });
    sendSuccess(res, { message: 'Sub-category deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createBuilding = async (req, res) => {
  try {
    const { name, code } = req.body;
    if (!name || !code) return sendError(res, 'name and code are required', 400);

    const building = await prisma.building.create({ data: { name, code } });
    broadcastMasterUpdate('building_created', building);
    sendSuccess(res, { building });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateBuilding = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, code, isActive } = req.body;

    const building = await prisma.building.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(code !== undefined && { code }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    broadcastMasterUpdate('building_updated', building);
    sendSuccess(res, { building });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteBuilding = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.building.delete({ where: { id } });
    broadcastMasterUpdate('building_deleted', { id });
    sendSuccess(res, { message: 'Building deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createFloor = async (req, res) => {
  try {
    const { buildingId, floorNumber, floorName } = req.body;
    if (!buildingId || floorNumber === undefined || !floorName) return sendError(res, 'buildingId, floorNumber, floorName are required', 400);

    const floor = await prisma.floor.create({ data: { buildingId, floorNumber: parseInt(floorNumber), floorName } });
    broadcastMasterUpdate('floor_created', floor);
    sendSuccess(res, { floor });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateFloor = async (req, res) => {
  try {
    const { id } = req.params;
    const { floorNumber, floorName, isActive } = req.body;

    const floor = await prisma.floor.update({
      where: { id },
      data: {
        ...(floorNumber !== undefined && { floorNumber: parseInt(floorNumber) }),
        ...(floorName !== undefined && { floorName }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    broadcastMasterUpdate('floor_updated', floor);
    sendSuccess(res, { floor });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteFloor = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.floor.delete({ where: { id } });
    broadcastMasterUpdate('floor_deleted', { id });
    sendSuccess(res, { message: 'Floor deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createRoom = async (req, res) => {
  try {
    const { buildingId, floorId, roomNumber, roomName } = req.body;
    if (!buildingId || !roomNumber || !roomName) return sendError(res, 'buildingId, roomNumber, roomName are required', 400);

    const room = await prisma.room.create({
      data: { buildingId, floorId: floorId || null, roomNumber, roomName },
    });

    broadcastMasterUpdate('room_created', room);
    sendSuccess(res, { room });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateRoom = async (req, res) => {
  try {
    const { id } = req.params;
    const { roomNumber, roomName, isActive, remark } = req.body;

    const remarkChanged = remark !== undefined;
    const room = await prisma.room.update({
      where: { id },
      data: {
        ...(roomNumber !== undefined && { roomNumber }),
        ...(roomName !== undefined && { roomName }),
        ...(isActive !== undefined && { isActive }),
        ...(remarkChanged && { remark: remark || null, remarkAt: remark ? new Date() : null }),
      },
      include: { building: true },
    });

    broadcastMasterUpdate('room_updated', room);

    if (remarkChanged && remark) {
      await notifyAllUsers(
        `Room ${room.roomNumber} Notice`,
        remark,
        { type: 'room_remark', roomId: id, roomNumber: room.roomNumber }
      );
    }

    sendSuccess(res, { room });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteRoom = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.room.delete({ where: { id } });
    broadcastMasterUpdate('room_deleted', { id });
    sendSuccess(res, { message: 'Room deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

const createLFCategory = async (req, res) => {
  try {
    const { name, type, displayOrder } = req.body;
    if (!name || !type) return sendError(res, 'name and type (found|lost) are required', 400);
    if (!['found', 'lost'].includes(type)) return sendError(res, 'type must be found or lost', 400);

    const cat = await prisma.lostFoundCategory.create({
      data: { name, type, displayOrder: displayOrder ?? 0 },
    });

    broadcastMasterUpdate('lf_category_created', cat);
    sendSuccess(res, { cat });
  } catch (err) {
    sendError(res, err.message);
  }
};

const updateLFCategory = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, displayOrder, isActive } = req.body;

    const cat = await prisma.lostFoundCategory.update({
      where: { id },
      data: {
        ...(name !== undefined && { name }),
        ...(displayOrder !== undefined && { displayOrder }),
        ...(isActive !== undefined && { isActive }),
      },
    });

    broadcastMasterUpdate('lf_category_updated', cat);
    sendSuccess(res, { cat });
  } catch (err) {
    sendError(res, err.message);
  }
};

const deleteLFCategory = async (req, res) => {
  try {
    const { id } = req.params;
    await prisma.lostFoundCategory.delete({ where: { id } });
    broadcastMasterUpdate('lf_category_deleted', { id });
    sendSuccess(res, { message: 'LF Category deleted' });
  } catch (err) {
    sendError(res, err.message);
  }
};

module.exports = {
  registerSSEClient,
  broadcastMasterUpdate,
  getAll,
  getAllAdmin,
  createCategory, updateCategory, deleteCategory,
  createSubCategory, updateSubCategory, deleteSubCategory,
  createBuilding, updateBuilding, deleteBuilding,
  createFloor, updateFloor, deleteFloor,
  createRoom, updateRoom, deleteRoom,
  createLFCategory, updateLFCategory, deleteLFCategory,
};