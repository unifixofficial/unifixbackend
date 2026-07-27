require('dotenv').config();
const prisma = require('../config/prisma');

const CATEGORIES = [
  { name: 'Electrical', iconName: 'flash-outline', color: '#f59e0b', designation: 'Electrician', displayOrder: 0, subs: ['Projector not working', 'AC not working', 'Fan not working', 'Light not working', 'Power socket issue', 'Wiring problem'] },
  { name: 'Plumbing', iconName: 'water-outline', color: '#3b82f6', designation: 'Plumber', displayOrder: 1, subs: ['Water leakage', 'Tap not working', 'Blocked drain', 'No water supply', 'Broken pipe'] },
  { name: 'Carpentry', iconName: 'hammer-outline', color: '#8b5cf6', designation: 'Carpenter', displayOrder: 2, subs: ['Broken desk', 'Broken chair', 'Door not closing', 'Window damaged', 'Cupboard broken', 'Shelf damaged'] },
  { name: 'Cleaning', iconName: 'sparkles-outline', color: '#10b981', designation: 'Cleaner', displayOrder: 3, subs: ['Classroom dirty', 'Garbage not collected', 'Floor not cleaned', 'Dustbin full', 'Bad smell'] },
  { name: 'Technician', iconName: 'desktop-outline', color: '#0ea5e9', designation: 'Technician', displayOrder: 4, subs: ['Computer not working', 'Projector issue', 'WiFi not working', 'Printer issue', 'Speaker not working', 'Smart board issue'] },
  { name: 'Washroom', iconName: 'man-outline', color: '#ec4899', designation: 'Cleaner', displayOrder: 5, subs: ['Washroom dirty', 'Water leakage in washroom', 'No water supply', 'Broken flush', 'Broken door/lock', 'Bad smell', 'Blocked drain'] },
  { name: 'Safety', iconName: 'shield-outline', color: '#ef4444', designation: 'Safety Officer', displayOrder: 6, subs: ['Emergency', 'Fire Hazard', 'Broken Stairs', 'Loose Railing', 'Suspicious Activity', 'Medical Emergency'] },
  { name: 'Others', iconName: 'construct-outline', color: '#6b7280', designation: null, displayOrder: 7, subs: [] },
];

const LF_CATEGORIES = [
  { name: 'Electronics', type: 'found', displayOrder: 0 },
  { name: 'Clothing', type: 'found', displayOrder: 1 },
  { name: 'Stationery', type: 'found', displayOrder: 2 },
  { name: 'Found ID Card', type: 'found', displayOrder: 3 },
  { name: 'Found Keys', type: 'found', displayOrder: 4 },
  { name: 'Found Bag', type: 'found', displayOrder: 5 },
  { name: 'Water Bottle', type: 'found', displayOrder: 6 },
  { name: 'Found Earphones', type: 'found', displayOrder: 7 },
  { name: 'Found Books', type: 'found', displayOrder: 8 },
  { name: 'Found Others', type: 'found', displayOrder: 9 },
  { name: 'Phone', type: 'lost', displayOrder: 0 },
  { name: 'Wallet', type: 'lost', displayOrder: 1 },
  { name: 'Lost Keys', type: 'lost', displayOrder: 2 },
  { name: 'Lost ID Card', type: 'lost', displayOrder: 3 },
  { name: 'Lost Bag', type: 'lost', displayOrder: 4 },
  { name: 'Laptop', type: 'lost', displayOrder: 5 },
  { name: 'Lost Earphones', type: 'lost', displayOrder: 6 },
  { name: 'Lost Books', type: 'lost', displayOrder: 7 },
  { name: 'Other', type: 'lost', displayOrder: 8 },
];

const FLOORS = [
  { floorNumber: 0, floorName: 'Ground Floor' },
  { floorNumber: 1, floorName: 'First Floor' },
  { floorNumber: 2, floorName: 'Second Floor' },
  { floorNumber: 3, floorName: 'Third Floor' },
  { floorNumber: 4, floorName: 'Fourth Floor' },
  { floorNumber: 5, floorName: 'Fifth Floor' },
];

const ROOMS = {
  "003A": "Photocopy Center",
  "003": "First Aid / Counselling Room",
  "004": "Conference Room",
  "005": "Ladies Toilet",
  "006": "Gents Toilet",
  "007": "Basic Workshop",
  "008": "Machine Shop",
  "009": "Seminar Hall",
  "010": "Lift Control Room",
  "011": "Gents Toilet",
  "012": "Ladies Toilet",
  "013": "Thermal Engineering Lab",
  "014": "Theory of Machines Lab",
  "015": "Refrigeration & AC Lab",
  "016": "HOD Civil Engineering",
  "017": "Geotechnics Lab",
  "018": "Building Material & Construction Technology Lab",
  "019": "Transportation Engineering Lab",
  "020": "Fluid Mechanics Lab",
  "021": "Applied Hydraulics Lab",
  "022": "Basic Workshop II",
  "023": "Material Testing Lab",
  "024": "HOD Mechanical Engineering",
  "101": "Administrative Office",
  "102": "Principal's Office",
  "104": "Principal's Office",
  "105": "Pantry",
  "106": "Record Room",
  "107": "Gents Toilet",
  "108": "Girls Room",
  "109": "Store Room",
  "111": "Store Room",
  "112": "CAD Center",
  "113": "Computer Lab B / Engineering",
  "114": "Networking & DevOps Lab",
  "115": "Programming & Project Lab",
  "116": "Gents Toilet",
  "117": "Environmental Engineering Lab",
  "118": "Meeting Room",
  "119": "Faculty Room",
  "120": "Robotics Lab",
  "121": "Robotics Lab",
  "122": "Room 122",
  "123": "Project Lab",
  "124": "Measurement & Automation / Maintenance Engineering Lab",
  "125": "Room 125",
  "126": "Room 126",
  "127": "Joint Director Office (Mr. VK Save)",
  "201": "Cubicles / Staff Room & Labs 1-3",
  "202": "HOD Computers",
  "203": "Handicap Toilet (M/F)",
  "204": "Ladies Toilet",
  "205": "Gents Toilet",
  "206": "UPS Room (Danger)",
  "207": "Room 207",
  "208": "Room 208",
  "209": "HOD IT",
  "210": "Room 210",
  "211": "Room 211",
  "212": "Ladies Staff Room",
  "213": "NSS / Dept Office",
  "214": "Classroom 1",
  "215": "Classroom 2",
  "216": "Classroom 3",
  "217": "Faculty Room",
  "218": "Classroom",
  "219": "Computer Center",
  "220": "Computer Center",
  "221": "Computer Center",
  "222": "Computer Center",
  "223": "Computer Center",
  "224": "Computer Center (Language Lab)",
  "301": "Gymkhana",
  "302": "Gymkhana",
  "303": "Room 303",
  "304": "Girls Toilet",
  "305": "Boys Toilet",
  "306": "Server Room",
  "307": "CSEDS Staff Room",
  "308": "CSEDS HOD / Labs",
  "309": "Lab",
  "310": "Boys Toilet",
  "311": "Girls Toilet",
  "312": "Tutorial Room",
  "313": "Classroom",
  "314": "Classroom",
  "315": "Classroom",
  "316": "Tutorial Room",
  "317": "Tutorial Room",
  "318": "Seminar Hall",
  "319": "Physics Lab",
  "320": "Classroom",
  "321": "Classroom",
  "322": "Chemistry Lab",
  "323": "Classroom",
  "401": "EXTC / VLSI Lab",
  "402": "EXTC / VLSI Lab",
  "403": "EXTC / VLSI Lab",
  "404": "Girls Toilet",
  "405": "Boys Toilet",
  "406": "HOD EXTC Cabin",
  "407": "EXTC / VLSI Lab",
  "408": "EXTC / VLSI Lab",
  "409": "EXTC / VLSI Lab",
  "410": "EXTC / VLSI Lab",
  "411": "EXTC / VLSI Lab",
  "412": "Boys Toilet",
  "413": "Girls Toilet",
  "414": "Tutorial Room",
  "415": "Classroom",
  "416": "Classroom",
  "417": "Classroom",
  "418": "Tutorial Room",
  "419": "Tutorial Room",
  "420": "Classroom",
  "421": "Drawing Hall",
  "422": "Classroom",
  "423": "Classroom",
  "424": "Classroom",
  "425": "Classroom",
  "426": "Tutorial Room",
  "501": "Staff Room",
  "502": "Staff Room",
  "503": "Staff Room",
  "504": "Girls Toilet",
  "505": "Boys Toilet",
  "512": "Boys Toilet",
  "513": "Girls Toilet",
  "514": "Tutorial Room",
  "515": "Classroom",
  "516": "Classroom",
  "517": "Classroom",
  "518": "MMS Staff Room",
  "519": "Classroom",
  "520": "Classroom",
  "527": "Student Activity Room (Council Room)",
};

function getFloorNumber(roomNumber) {
  const digits = roomNumber.replace(/\D/g, '');
  if (!digits) return 0;
  return Math.floor(parseInt(digits, 10) / 100);
}

async function main() {
  console.log('Clearing old data...');
  await prisma.subCategory.deleteMany({});
  await prisma.category.deleteMany({});
  await prisma.lostFoundCategory.deleteMany({});
  await prisma.room.deleteMany({});
  await prisma.floor.deleteMany({});
  await prisma.building.deleteMany({});

  console.log('Seeding categories...');
  for (const cat of CATEGORIES) {
    const { subs, ...catData } = cat;
    const created = await prisma.category.create({ data: catData });
    if (subs.length > 0) {
      await prisma.subCategory.createMany({
        data: subs.map((name, i) => ({ categoryId: created.id, name, displayOrder: i })),
      });
    }
  }
  console.log('Categories done.');

  console.log('Seeding LF categories...');
  await prisma.lostFoundCategory.createMany({ data: LF_CATEGORIES });
  console.log('LF categories done.');

  console.log('Seeding building...');
  const building = await prisma.building.create({
    data: { name: 'VCET Main Building', code: 'VCET' },
  });

  console.log('Seeding floors...');
  const floorMap = {};
  for (const f of FLOORS) {
    const floor = await prisma.floor.create({
      data: { buildingId: building.id, floorNumber: f.floorNumber, floorName: f.floorName },
    });
    floorMap[f.floorNumber] = floor.id;
  }

  console.log('Seeding rooms...');
  const roomData = Object.entries(ROOMS).map(([roomNumber, roomName]) => ({
    buildingId: building.id,
    floorId: floorMap[getFloorNumber(roomNumber)] ?? floorMap[0],
    roomNumber,
    roomName,
  }));
  await prisma.room.createMany({ data: roomData });

  console.log(`Done. ${roomData.length} rooms, ${CATEGORIES.length} categories, ${LF_CATEGORIES.length} LF categories seeded.`);
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());