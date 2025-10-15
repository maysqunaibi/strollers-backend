const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

(async () => {
  const count = await prisma.package.count();
  if (count === 0) {
    await prisma.package.createMany({
      data: [
        { set_key:'MALL_DEFAULT', site_type:'SHOPPING_MALL', name:'Starter 30 min',  amount_halalas:1000, duration_minutes:30,  display_order:1, recommended:0, active:1 },
        { set_key:'MALL_DEFAULT', site_type:'SHOPPING_MALL', name:'Standard 60 min', amount_halalas:1500, duration_minutes:60,  display_order:2, recommended:1, active:1 },
        { set_key:'MALL_DEFAULT', site_type:'SHOPPING_MALL', name:'Extended 120 min',amount_halalas:2500, duration_minutes:120, display_order:3, recommended:0, active:1 },
        { set_key:'MALL_DEFAULT', site_type:'SHOPPING_MALL', name:'Day cap',         amount_halalas:5000, duration_minutes:1440,display_order:4, recommended:0, active:1 },
      ]
    });
    console.log('Seeded packages.');
  } else {
    console.log('Packages already present.');
  }
  await prisma.$disconnect();
})();
