const express = require('express');
const router = express.Router();
const verifyToken = require('../middleware/verifyToken');
const { allowRoles } = require('../middleware/roleMiddleware');
const m = require('../controllers/masterController');

router.get('/stream', m.registerSSEClient);
router.get('/all', m.getAll);

const adminOnly = [verifyToken, allowRoles('admin')];

router.get('/admin/all', ...adminOnly, m.getAllAdmin);

router.post('/categories', ...adminOnly, m.createCategory);
router.put('/categories/:id', ...adminOnly, m.updateCategory);
router.delete('/categories/:id', ...adminOnly, m.deleteCategory);

router.post('/subcategories', ...adminOnly, m.createSubCategory);
router.put('/subcategories/:id', ...adminOnly, m.updateSubCategory);
router.delete('/subcategories/:id', ...adminOnly, m.deleteSubCategory);

router.post('/buildings', ...adminOnly, m.createBuilding);
router.put('/buildings/:id', ...adminOnly, m.updateBuilding);
router.delete('/buildings/:id', ...adminOnly, m.deleteBuilding);

router.post('/floors', ...adminOnly, m.createFloor);
router.put('/floors/:id', ...adminOnly, m.updateFloor);
router.delete('/floors/:id', ...adminOnly, m.deleteFloor);

router.post('/rooms', ...adminOnly, m.createRoom);
router.put('/rooms/:id', ...adminOnly, m.updateRoom);
router.delete('/rooms/:id', ...adminOnly, m.deleteRoom);

router.post('/lf-categories', ...adminOnly, m.createLFCategory);
router.put('/lf-categories/:id', ...adminOnly, m.updateLFCategory);
router.delete('/lf-categories/:id', ...adminOnly, m.deleteLFCategory);

module.exports = router;