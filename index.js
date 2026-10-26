const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cookieParser = require('cookie-parser');
const { z } = require('zod');
const path = require('path');

const app = express();

// --- SECURITY & MIDDLEWARE ---
app.use(helmet({ contentSecurityPolicy: false })); // CSP disabled for inline scripts in demo
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

const apiLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 100, message: { error: 'Too many requests' } });
app.use('/api', apiLimiter);

// --- MONGODB CONNECTION (Serverless Optimized) ---
let isConnected = false;
const connectDB = async () => {
  if (isConnected) return;
  try {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI missing');
    await mongoose.connect(process.env.MONGODB_URI, { maxPoolSize: 10 });
    isConnected = true;
    console.log('MongoDB connected');
  } catch (err) {
    console.error('MongoDB connection error:', err);
  }
};
app.use(async (req, res, next) => { await connectDB(); next(); });

// --- SCHEMAS & MODELS ---
const serviceSchema = new mongoose.Schema({
  name: { type: String, required: true },
  description: String,
  price: Number,
  durationMinutes: Number,
  category: String,
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const dentistSchema = new mongoose.Schema({
  name: { type: String, required: true },
  designation: String,
  biography: String,
  availableDays: [String],
  workingHours: { start: { type: String, default: "09:00" }, end: { type: String, default: "17:00" } },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const appointmentSchema = new mongoose.Schema({
  bookingReference: { type: String, unique: true },
  patientName: { type: String, required: true },
  patientPhone: { type: String, required: true },
  patientEmail: String,
  serviceId: { type: mongoose.Schema.Types.ObjectId, ref: 'Service' },
  serviceNameSnapshot: String,
  dentistId: { type: mongoose.Schema.Types.ObjectId, ref: 'Dentist' },
  dentistNameSnapshot: String,
  appointmentDate: String,
  startTime: String,
  endTime: String,
  timeZone: { type: String, default: 'Asia/Karachi' },
  status: { type: String, enum: ['pending', 'confirmed', 'completed', 'cancelled', 'rejected'], default: 'pending' },
  patientNote: String
}, { timestamps: true });
appointmentSchema.index({ appointmentDate: 1, dentistId: 1, status: 1 });

const adminSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true },
  passwordHash: { type: String, required: true },
  isActive: { type: Boolean, default: true }
}, { timestamps: true });

const contactSchema = new mongoose.Schema({
  name: String, email: String, phone: String, message: String, status: { type: String, default: 'unread' }
}, { timestamps: true });

const Service = mongoose.models.Service || mongoose.model('Service', serviceSchema);
const Dentist = mongoose.models.Dentist || mongoose.model('Dentist', dentistSchema);
const Appointment = mongoose.models.Appointment || mongoose.model('Appointment', appointmentSchema);
const Admin = mongoose.models.Admin || mongoose.model('Admin', adminSchema);
const ContactMessage = mongoose.models.ContactMessage || mongoose.model('ContactMessage', contactSchema);

// --- AUTH MIDDLEWARE ---
const authAdmin = (req, res, next) => {
  const token = req.cookies.adminToken;
  if (!token) return res.status(401).json({ error: 'Unauthorized' });
  try {
    req.admin = jwt.verify(token, process.env.JWT_SECRET);
    next();
  } catch (err) { res.status(401).json({ error: 'Invalid token' }); }
};

// --- API ROUTES: PUBLIC ---
app.get('/api/health', (req, res) => res.json({ status: 'ok', db: isConnected }));

app.get('/api/services', async (req, res) => {
  const services = await Service.find({ isActive: true }).select('-__v');
  res.json(services);
});

app.get('/api/dentists', async (req, res) => {
  const dentists = await Dentist.find({ isActive: true }).select('-__v');
  res.json(dentists);
});

app.get('/api/availability', async (req, res) => {
  try {
    const { serviceId, dentistId, date } = req.query;
    if (!serviceId || !dentistId || !date) return res.status(400).json({ error: 'Missing params' });
    const dentist = await Dentist.findById(dentistId);
    const service = await Service.findById(serviceId);
    if (!dentist || !service) return res.status(404).json({ error: 'Invalid selection' });
    
    const dayName = new Date(date).toLocaleDateString('en-US', { weekday: 'long' });
    if (!dentist.availableDays.includes(dayName)) return res.json({ slots: [] });

    const apps = await Appointment.find({ dentistId, appointmentDate: date, status: { $nin: ['cancelled', 'rejected'] } });
    const slots = [];
    let [currH, currM] = dentist.workingHours.start.split(':').map(Number);
    const [endH, endM] = dentist.workingHours.end.split(':').map(Number);
    let curr = currH * 60 + currM;
    const end = endH * 60 + endM;
    
    while (curr + service.durationMinutes <= end) {
      const slotEnd = curr + service.durationMinutes;
      const overlap = apps.some(a => {
        const aStart = a.startTime.split(':').map(Number).reduce((h,m)=>h*60+m);
        const aEnd = a.endTime.split(':').map(Number).reduce((h,m)=>h*60+m);
        return (curr < aEnd && slotEnd > aStart);
      });
      if (!overlap) {
        slots.push(`${String(Math.floor(curr/60)).padStart(2,'0')}:${String(curr%60).padStart(2,'0')}`);
      }
      curr += 30;
    }
    res.json({ slots });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.post('/api/appointments', async (req, res) => {
  try {
    const { patientName, patientPhone, patientEmail, serviceId, dentistId, appointmentDate, startTime, patientNote } = req.body;
    if (!patientName || !patientPhone || !serviceId || !dentistId || !appointmentDate || !startTime) return res.status(400).json({ error: 'Missing fields' });
    
    const service = await Service.findById(serviceId);
    const dentist = await Dentist.findById(dentistId);
    if (!service || !dentist) return res.status(404).json({ error: 'Not found' });
    
    const startMins = startTime.split(':').map(Number).reduce((h,m)=>h*60+m);
    const endMins = startMins + service.durationMinutes;
    const endTime = `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;
    
    // Concurrency / Availability check
    const apps = await Appointment.find({ dentistId, appointmentDate, status: { $nin: ['cancelled', 'rejected'] } });
    const overlap = apps.some(a => {
      const aStart = a.startTime.split(':').map(Number).reduce((h,m)=>h*60+m);
      const aEnd = a.endTime.split(':').map(Number).reduce((h,m)=>h*60+m);
      return (startMins < aEnd && endMins > aStart);
    });
    if (overlap) return res.status(409).json({ error: 'Slot no longer available' });
    
    const bookingReference = 'DC-' + Math.random().toString(36).substr(2, 6).toUpperCase();
    await Appointment.create({
      bookingReference, patientName, patientPhone, patientEmail, serviceId, serviceNameSnapshot: service.name,
      dentistId, dentistNameSnapshot: dentist.name, appointmentDate, startTime, endTime, patientNote
    });
    res.status(201).json({ bookingReference, message: 'Booking pending confirmation' });
  } catch (e) { res.status(500).json({ error: 'Server error' }); }
});

app.get('/api/appointments/lookup/:ref', async (req, res) => {
  if (!req.query.phone) return res.status(400).json({ error: 'Phone required' });
  const appt = await Appointment.findOne({ bookingReference: req.params.ref, patientPhone: req.query.phone });
  if (!appt) return res.status(404).json({ error: 'Not found' });
  res.json({ reference: appt.bookingReference, status: appt.status, date: appt.appointmentDate, time: appt.startTime, service: appt.serviceNameSnapshot });
});

app.post('/api/contact', async (req, res) => {
  try {
    const schema = z.object({ name: z.string().min(1), email: z.string().email(), phone: z.string().optional(), message: z.string().min(5) });
    await ContactMessage.create(schema.parse(req.body));
    res.status(201).json({ message: 'Sent' });
  } catch (e) { res.status(400).json({ error: 'Invalid payload' }); }
});

// --- API ROUTES: ADMIN AUTH & BOOTSTRAP ---
app.post('/api/admin/bootstrap', async (req, res) => {
  try {
    if (req.body.secret !== process.env.ADMIN_BOOTSTRAP_SECRET) return res.status(403).json({ error: 'Forbidden' });
    if (await Admin.countDocuments() > 0) return res.status(400).json({ error: 'Admin exists' });
    
    const passwordHash = await bcrypt.hash(req.body.password, 10);
    await Admin.create({ email: req.body.email, passwordHash });
    
    // Seed Demo Data
    if (await Service.countDocuments() === 0) {
      await Service.insertMany([
        { name: 'General Checkup', price: 1500, durationMinutes: 30, category: 'General', description: 'Comprehensive examination.' },
        { name: 'Teeth Whitening', price: 8000, durationMinutes: 60, category: 'Cosmetic', description: 'Advanced whitening.' },
        { name: 'Root Canal Consult', price: 2000, durationMinutes: 45, category: 'Endodontics', description: 'Expert evaluation.' }
      ]);
    }
    if (await Dentist.countDocuments() === 0) {
      await Dentist.insertMany([
        { name: 'Dr. Sarah Ahmed', designation: 'Senior Surgeon', availableDays: ['Monday','Wednesday','Friday'], biography: '10 years experience.' },
        { name: 'Dr. Ali Khan', designation: 'Orthodontist', availableDays: ['Tuesday','Thursday','Saturday'], biography: 'Braces specialist.' }
      ]);
    }
    res.json({ message: 'System bootstrapped safely' });
  } catch (e) { res.status(500).json({ error: 'Error' }); }
});

app.post('/api/admin/login', async (req, res) => {
  const admin = await Admin.findOne({ email: req.body.email });
  if (!admin || !(await bcrypt.compare(req.body.password, admin.passwordHash))) return res.status(401).json({ error: 'Invalid credentials' });
  const token = jwt.sign({ id: admin._id, email: admin.email }, process.env.JWT_SECRET, { expiresIn: '8h' });
  res.cookie('adminToken', token, { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'strict' });
  res.json({ message: 'Logged in' });
});
app.post('/api/admin/logout', (req, res) => { res.clearCookie('adminToken'); res.json({ message: 'Logged out' }); });
app.get('/api/admin/me', authAdmin, (req, res) => res.json({ email: req.admin.email }));

// --- API ROUTES: PROTECTED ADMIN ---
app.get('/api/admin/dashboard', authAdmin, async (req, res) => {
  const total = await Appointment.countDocuments();
  const pending = await Appointment.countDocuments({ status: 'pending' });
  const confirmed = await Appointment.countDocuments({ status: 'confirmed' });
  const recent = await Appointment.find().sort({ createdAt: -1 }).limit(10);
  res.json({ stats: { total, pending, confirmed }, recent });
});
app.get('/api/admin/appointments', authAdmin, async (req, res) => res.json(await Appointment.find().sort({ appointmentDate: -1, startTime: -1 })));
app.patch('/api/admin/appointments/:id/status', authAdmin, async (req, res) => {
  const a = await Appointment.findByIdAndUpdate(req.params.id, { status: req.body.status }, { new: true });
  res.json(a);
});
app.get('/api/admin/services', authAdmin, async (req, res) => res.json(await Service.find()));
app.post('/api/admin/services', authAdmin, async (req, res) => res.status(201).json(await Service.create(req.body)));
app.patch('/api/admin/services/:id', authAdmin, async (req, res) => res.json(await Service.findByIdAndUpdate(req.params.id, req.body)));
app.delete('/api/admin/services/:id', authAdmin, async (req, res) => { await Service.findByIdAndDelete(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/dentists', authAdmin, async (req, res) => res.json(await Dentist.find()));
app.post('/api/admin/dentists', authAdmin, async (req, res) => res.status(201).json(await Dentist.create(req.body)));
app.patch('/api/admin/dentists/:id', authAdmin, async (req, res) => res.json(await Dentist.findByIdAndUpdate(req.params.id, req.body)));
app.delete('/api/admin/dentists/:id', authAdmin, async (req, res) => { await Dentist.findByIdAndDelete(req.params.id); res.json({ ok: true }); });
app.get('/api/admin/contacts', authAdmin, async (req, res) => res.json(await ContactMessage.find().sort({ createdAt: -1 })));
app.patch('/api/admin/contacts/:id/status', authAdmin, async (req, res) => res.json(await ContactMessage.findByIdAndUpdate(req.params.id, { status: req.body.status })));

// --- PUBLIC WEBSITE HTML (Served by index.js) ---
const publicWebsiteHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>DentalCare — Modern Dental Studio</title>
  <meta name="description" content="Your Healthiest Smile Starts Here. Demo application.">
  <style>
    :root { --primary: #A78BFA; --violet: #E9DFFF; --mint: #B8F3E4; --blue: #BDE0FE; --peach: #FFD6C2; --yellow: #FFE9A8; --bg: #F8F7FF; --surface: #FFFFFF; --text: #292642; --text-light: #706D86; --radius: 24px; --clay: 12px 12px 24px #e4e1f0, -12px -12px 24px #ffffff; --clay-inset: inset 6px 6px 12px #e4e1f0, inset -6px -6px 12px #ffffff; }
    body { margin: 0; padding: 0; font-family: 'Inter', system-ui, sans-serif; background: var(--bg); color: var(--text); overflow-x: hidden; }
    .clay-card { background: var(--surface); border-radius: var(--radius); box-shadow: var(--clay); padding: 30px; margin-bottom: 20px; }
    .clay-btn { background: var(--primary); color: white; border: none; padding: 14px 28px; border-radius: 99px; font-weight: bold; cursor: pointer; box-shadow: 6px 6px 12px #c9bcf0, -6px -6px 12px #ffffff; transition: 0.3s; }
    .clay-btn:hover { transform: translateY(-2px); box-shadow: 8px 8px 16px #c9bcf0, -8px -8px 16px #ffffff; }
    .clay-btn:active { transform: translateY(0); box-shadow: inset 4px 4px 8px #967de3, inset -4px -4px 8px #b89dff; }
    .clay-input { background: var(--bg); color: var(--text); width: 100%; border: none; padding: 16px; border-radius: 16px; box-shadow: var(--clay-inset); margin-bottom: 20px; box-sizing: border-box; font-size: 15px; outline: none; }
    header.nav { position: sticky; top: 0; background: rgba(248,247,255,0.9); backdrop-filter: blur(10px); z-index: 100; padding: 15px 40px; display: flex; justify-content: space-between; align-items: center; box-shadow: 0 4px 15px rgba(0,0,0,0.02); }
    .logo { font-size: 24px; font-weight: 900; color: var(--primary); display:flex; align-items:center; gap:8px;}
    .nav-links a { text-decoration: none; color: var(--text); font-weight: 600; margin: 0 15px; transition: color 0.2s;}
    .nav-links a:hover { color: var(--primary); }
    .hero { display: flex; align-items: center; padding: 80px 40px; max-width: 1200px; margin: 0 auto; min-height: 70vh; gap: 40px; }
    .hero-text { flex: 1; }
    .hero-text h1 { font-size: 54px; margin: 10px 0; line-height: 1.2; }
    .hero-text p { font-size: 18px; color: var(--text-light); margin-bottom: 30px; line-height: 1.6; }
    .hero-img { flex: 1; display: flex; justify-content: center; position: relative; }
    .hero-badge { display: inline-block; background: var(--violet); color: var(--primary); padding: 8px 16px; border-radius: 20px; font-weight: bold; font-size: 14px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 30px; }
    .section { padding: 80px 40px; max-width: 1200px; margin: 0 auto; }
    .section-title { text-align: center; font-size: 36px; margin-bottom: 50px; }
    .service-card { border-top: 6px solid var(--mint); display: flex; flex-direction: column; justify-content: space-between;}
    .service-card:nth-child(2n) { border-top-color: var(--blue); }
    .service-card:nth-child(3n) { border-top-color: var(--peach); }
    .dentist-card img { width: 100%; height: 250px; object-fit: cover; border-radius: 16px; margin-bottom: 15px; background: var(--yellow); }
    /* Booking Modal */
    .modal-overlay { position: fixed; top:0; left:0; width:100%; height:100%; background: rgba(41,38,66,0.6); z-index: 1000; display: none; justify-content: center; align-items: center; padding: 20px; box-sizing: border-box; backdrop-filter: blur(5px); }
    .modal-box { width: 100%; max-width: 600px; max-height: 90vh; overflow-y: auto; background: var(--bg); }
    .step { display: none; }
    .step.active { display: block; animation: slideUp 0.4s ease; }
    .step-indicator { display: flex; justify-content: space-between; margin-bottom: 20px; font-size: 14px; font-weight: bold; color: var(--text-light); }
    .slot-btn { background: var(--surface); border: 2px solid transparent; padding: 10px; border-radius: 12px; cursor: pointer; text-align: center; box-shadow: var(--clay); margin: 5px; width: calc(33% - 10px); display: inline-block; font-weight:600;}
    .slot-btn.selected { border-color: var(--primary); background: var(--violet); }
    .radio-card { display: block; padding: 15px; margin-bottom: 15px; background: var(--surface); border-radius: 16px; cursor: pointer; box-shadow: var(--clay); border: 2px solid transparent; }
    .radio-card input { display: none; }
    .radio-card input:checked + div { color: var(--primary); font-weight: bold; }
    .radio-card:has(input:checked) { border-color: var(--primary); }
    @keyframes slideUp { from { opacity: 0; transform: translateY(20px); } to { opacity: 1; transform: translateY(0); } }
    .animate-on-scroll { opacity: 0; transform: translateY(30px); transition: 0.6s all ease-out; }
    .fade-in { opacity: 1; transform: translateY(0); }
    footer { background: var(--surface); padding: 40px; text-align: center; color: var(--text-light); margin-top: 50px;}
    .announcement { background: var(--peach); text-align: center; padding: 10px; font-weight: 600; font-size: 14px; }
    @media (max-width: 768px) {
      .hero { flex-direction: column; text-align: center; padding: 40px 20px; }
      .nav-links { display: none; }
    }
  </style>
</head>
<body>
  <div class="announcement" id="announce">Welcome to your new favorite dental studio — book your visit online. <button style="float:right; border:none; background:transparent; cursor:pointer;" onclick="document.getElementById('announce').style.display='none'">✖</button></div>
  <header class="nav">
    <div class="logo">🦷 DentalCare</div>
    <div class="nav-links">
      <a href="#services">Services</a>
      <a href="#dentists">Our Dentists</a>
      <a href="#testimonials">Testimonials</a>
      <a href="#faq">FAQ</a>
    </div>
    <button class="clay-btn" onclick="openBookingModal()">Book Appointment</button>
  </header>

  <main>
    <section class="hero animate-on-scroll">
      <div class="hero-text">
        <span class="hero-badge">Gentle Care. Beautiful Smiles.</span>
        <h1>A Brighter Smile Begins With You.</h1>
        <p>Experience comfortable, personalized dental care in a modern studio designed to put you at ease. (Demo Environment)</p>
        <button class="clay-btn" onclick="openBookingModal()">Book Your Visit</button>
        <button class="clay-btn" style="background:var(--surface); color:var(--text);" onclick="document.getElementById('services').scrollIntoView()">Explore Services</button>
      </div>
      <div class="hero-img">
        <div class="clay-card" style="width: 300px; height: 350px; background: var(--mint); display:flex; align-items:center; justify-content:center; font-size: 80px;">👨‍⚕️✨</div>
      </div>
    </section>

    <section id="services" class="section animate-on-scroll">
      <h2 class="section-title">Our Services</h2>
      <div class="grid" id="servicesGrid">Loading...</div>
    </section>

    <section id="dentists" class="section animate-on-scroll">
      <h2 class="section-title">Meet Our Dentists</h2>
      <div class="grid" id="dentistsGrid">Loading...</div>
    </section>

    <section id="how-it-works" class="section animate-on-scroll">
      <h2 class="section-title">How It Works</h2>
      <div class="grid text-center">
        <div class="clay-card"><h3>1. Select Service</h3><p>Choose the treatment you need.</p></div>
        <div class="clay-card"><h3>2. Choose Dentist</h3><p>Pick your preferred expert.</p></div>
        <div class="clay-card"><h3>3. Pick a Time</h3><p>Find a convenient slot.</p></div>
        <div class="clay-card"><h3>4. Confirm</h3><p>We'll verify your booking.</p></div>
      </div>
    </section>

    <section id="faq" class="section animate-on-scroll">
      <h2 class="section-title">Frequently Asked Questions</h2>
      <div class="clay-card" onclick="toggleFaq(this)" style="cursor:pointer;">
        <h3 style="margin:0;">How do I book an appointment?</h3>
        <p class="faq-content" style="display:none; color:var(--text-light); margin-top:10px;">Click the Book Appointment button and follow the 4 simple steps. Your request is subject to confirmation.</p>
      </div>
      <div class="clay-card" onclick="toggleFaq(this)" style="cursor:pointer;">
        <h3 style="margin:0;">Are the prices fixed?</h3>
        <p class="faq-content" style="display:none; color:var(--text-light); margin-top:10px;">Prices shown are sample demonstration prices. Final costs are provided after in-clinic consultation.</p>
      </div>
    </section>
  </main>

  <footer>
    <h2 style="color:var(--primary);">🦷 DentalCare Modern Dental Studio</h2>
    <p>24 Wellness Avenue, Clifton, Karachi, Pakistan</p>
    <p>Phone/WhatsApp: +92 300 1234567 | Email: hello@dentalcare-demo.example</p>
    <p style="font-size: 12px; margin-top:30px;">© 2026 DentalCare (Demonstration System). Not a real medical facility.</p>
  </footer>

  <!-- Booking Modal Structure -->
  <div class="modal-overlay" id="bookingModal">
    <div class="clay-card modal-box">
      <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
        <h2 style="margin:0;">Book Appointment</h2>
        <button onclick="closeBookingModal()" style="border:none; background:transparent; font-size:24px; cursor:pointer;">✖</button>
      </div>
      
      <div class="step-indicator" id="stepIndicator">Step 1 of 5</div>
      
      <div id="step1" class="step active">
        <h3>Select a Service</h3>
        <div id="modalServices"></div>
        <button class="clay-btn" style="width:100%; margin-top:20px;" onclick="nextStep(2)">Continue</button>
      </div>

      <div id="step2" class="step">
        <h3>Select a Dentist</h3>
        <div id="modalDentists"></div>
        <div style="display:flex; gap:10px; margin-top:20px;">
          <button class="clay-btn" style="background:var(--surface); color:var(--text);" onclick="nextStep(1)">Back</button>
          <button class="clay-btn" style="flex:1;" onclick="nextStep(3)">Continue</button>
        </div>
      </div>

      <div id="step3" class="step">
        <h3>Select Date & Time</h3>
        <input type="date" id="bookDate" class="clay-input" onchange="fetchSlots()" min="\${new Date().toISOString().split('T')[0]}">
        <div id="modalSlots" style="margin-top:15px; max-height:200px; overflow-y:auto;">Select a date to see availability.</div>
        <div style="display:flex; gap:10px; margin-top:20px;">
          <button class="clay-btn" style="background:var(--surface); color:var(--text);" onclick="nextStep(2)">Back</button>
          <button class="clay-btn" style="flex:1;" onclick="nextStep(4)" id="btnStep3" disabled>Continue</button>
        </div>
      </div>

      <div id="step4" class="step">
        <h3>Your Details</h3>
        <input type="text" id="bookName" class="clay-input" placeholder="Full Name" required>
        <input type="tel" id="bookPhone" class="clay-input" placeholder="Phone Number" required>
        <input type="email" id="bookEmail" class="clay-input" placeholder="Email (Optional)">
        <textarea id="bookNote" class="clay-input" placeholder="Any special requests?"></textarea>
        <p id="bookingError" style="color:var(--error); font-weight:bold;"></p>
        <div style="display:flex; gap:10px; margin-top:20px;">
          <button class="clay-btn" style="background:var(--surface); color:var(--text);" onclick="nextStep(3)">Back</button>
          <button class="clay-btn" style="flex:1;" id="btnSubmitBooking" onclick="submitBooking()">Confirm Booking</button>
        </div>
      </div>

      <div id="step5" class="step" style="text-align:center;">
        <div style="font-size:60px;">🎉</div>
        <h3>Booking Submitted!</h3>
        <p>Your request is pending clinic confirmation.</p>
        <p>Reference: <strong id="refDisplay" style="font-size:24px; color:var(--primary);"></strong></p>
        <button class="clay-btn" style="margin-top:20px;" onclick="closeBookingModal()">Done</button>
      </div>

    </div>
  </div>

  <script>
    let servicesData = [];
    let dentistsData = [];
    let bookingData = { serviceId: null, dentistId: null, date: null, time: null };

    // Initial Fetch
    Promise.all([fetch('/api/services').then(r=>r.json()), fetch('/api/dentists').then(r=>r.json())])
      .then(([s, d]) => {
        servicesData = s; dentistsData = d;
        
        document.getElementById('servicesGrid').innerHTML = s.map(x => 
          '<div class="clay-card service-card"><h3>'+x.name+'</h3><p style="color:var(--text-light);">'+x.description+'</p><h4>PKR '+x.price+' • '+x.durationMinutes+' mins</h4><button class="clay-btn" onclick="openBookingModal(\\''+x._id+'\\')">Book</button></div>'
        ).join('');
        
        document.getElementById('modalServices').innerHTML = s.map(x => 
          '<label class="radio-card"><input type="radio" name="bservice" value="'+x._id+'" onchange="bookingData.serviceId=this.value"><div>'+x.name+' (PKR '+x.price+')</div></label>'
        ).join('');

        document.getElementById('dentistsGrid').innerHTML = d.map(x => 
          '<div class="clay-card dentist-card"><div style="background:var(--blue); border-radius:16px; height:200px; display:flex; align-items:center; justify-content:center; font-size:60px; margin-bottom:15px;">🧑‍⚕️</div><h3>'+x.name+'</h3><p>'+x.designation+'</p><p style="font-size:14px; color:var(--text-light);">'+x.biography+'</p><button class="clay-btn" style="width:100%" onclick="openBookingModal(null, \\''+x._id+'\\')">Select Dentist</button></div>'
        ).join('');

        document.getElementById('modalDentists').innerHTML = d.map(x => 
          '<label class="radio-card"><input type="radio" name="bdentist" value="'+x._id+'" onchange="bookingData.dentistId=this.value"><div>'+x.name+' - '+x.designation+'</div></label>'
        ).join('');
      });

    function toggleFaq(el) {
      const p = el.querySelector('.faq-content');
      p.style.display = p.style.display === 'none' ? 'block' : 'none';
    }

    // Scroll Animations
    const observer = new IntersectionObserver(entries => {
      entries.forEach(e => { if(e.isIntersecting) e.target.classList.add('fade-in'); });
    });
    document.querySelectorAll('.animate-on-scroll').forEach(el => observer.observe(el));

    // Booking Flow
    function openBookingModal(srvId = null, dentId = null) {
      document.getElementById('bookingModal').style.display = 'flex';
      if(srvId) {
        document.querySelector('input[name="bservice"][value="'+srvId+'"]').checked = true;
        bookingData.serviceId = srvId;
        nextStep(2);
      } else { nextStep(1); }
      if(dentId) {
        setTimeout(() => {
          document.querySelector('input[name="bdentist"][value="'+dentId+'"]').checked = true;
          bookingData.dentistId = dentId;
        }, 100);
      }
    }
    function closeBookingModal() { document.getElementById('bookingModal').style.display = 'none'; }
    
    function nextStep(n) {
      if(n===2 && !bookingData.serviceId) return alert('Select a service');
      if(n===3 && !bookingData.dentistId) return alert('Select a dentist');
      if(n===4 && !bookingData.time) return alert('Select date and time');
      
      document.querySelectorAll('.step').forEach(e => e.classList.remove('active'));
      document.getElementById('step'+n).classList.add('active');
      document.getElementById('stepIndicator').innerText = 'Step '+n+' of 5';
    }

    async function fetchSlots() {
      const date = document.getElementById('bookDate').value;
      if(!date || !bookingData.serviceId || !bookingData.dentistId) return;
      bookingData.date = date;
      document.getElementById('modalSlots').innerHTML = 'Loading...';
      try {
        const res = await fetch('/api/availability?date='+date+'&serviceId='+bookingData.serviceId+'&dentistId='+bookingData.dentistId);
        const data = await res.json();
        if(data.slots.length === 0) {
          document.getElementById('modalSlots').innerHTML = '<p>No slots available on this date.</p>';
          return;
        }
        document.getElementById('modalSlots').innerHTML = data.slots.map(t => 
          '<div class="slot-btn" onclick="selectSlot(this, \\''+t+'\\')">'+t+'</div>'
        ).join('');
      } catch(e) { document.getElementById('modalSlots').innerHTML = 'Error loading slots.'; }
    }

    function selectSlot(el, time) {
      document.querySelectorAll('.slot-btn').forEach(b => b.classList.remove('selected'));
      el.classList.add('selected');
      bookingData.time = time;
      document.getElementById('btnStep3').disabled = false;
    }

    async function submitBooking() {
      const name = document.getElementById('bookName').value;
      const phone = document.getElementById('bookPhone').value;
      if(!name || !phone) return alert('Name and phone required');
      
      const btn = document.getElementById('btnSubmitBooking');
      btn.innerText = 'Processing...'; btn.disabled = true;
      
      const payload = {
        patientName: name, patientPhone: phone, patientEmail: document.getElementById('bookEmail').value,
        serviceId: bookingData.serviceId, dentistId: bookingData.dentistId,
        appointmentDate: bookingData.date, startTime: bookingData.time,
        patientNote: document.getElementById('bookNote').value
      };

      try {
        const res = await fetch('/api/appointments', {
          method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(payload)
        });
        const data = await res.json();
        if(res.ok) {
          document.getElementById('refDisplay').innerText = data.bookingReference;
          nextStep(5);
        } else {
          document.getElementById('bookingError').innerText = data.error;
          btn.innerText = 'Confirm Booking'; btn.disabled = false;
        }
      } catch(e) {
        document.getElementById('bookingError').innerText = 'Network error.';
        btn.innerText = 'Confirm Booking'; btn.disabled = false;
      }
    }
  </script>
</body>
</html>
`;

app.get('/', (req, res) => res.send(publicWebsiteHTML));

// --- ADMIN DASHBOARD HTML (Served by index.js) ---
const adminHTML = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Admin Dashboard - DentalCare</title>
  <style>
    :root { --bg: #F8F7FF; --surface: #FFFFFF; --primary: #A78BFA; --text: #292642; --shadow: 8px 8px 16px #e4e1f0, -8px -8px 16px #ffffff; }
    body { margin: 0; font-family: sans-serif; background: var(--bg); color: var(--text); display: flex; height: 100vh; overflow: hidden;}
    .sidebar { width: 250px; background: var(--surface); padding: 20px; box-shadow: 4px 0 10px rgba(0,0,0,0.05); display: flex; flex-direction: column; gap: 10px;}
    .main { flex: 1; padding: 40px; overflow-y: auto; }
    .clay-card { background: var(--surface); border-radius: 20px; padding: 20px; box-shadow: var(--shadow); margin-bottom: 20px; }
    .nav-item { padding: 12px 16px; cursor: pointer; border-radius: 12px; font-weight: bold; transition: 0.2s; }
    .nav-item:hover, .nav-item.active { background: var(--primary); color: white; }
    .hidden { display: none !important; }
    table { width: 100%; border-collapse: collapse; margin-top: 15px; }
    th, td { padding: 12px; text-align: left; border-bottom: 1px solid #eee; }
    .clay-btn { background: var(--primary); color: white; border: none; padding: 10px 20px; border-radius: 12px; cursor: pointer; font-weight: bold; }
    .clay-input { width: 100%; padding: 12px; border-radius: 12px; border: 1px solid #ddd; margin-bottom: 10px; box-sizing: border-box; }
    .badge { padding: 5px 10px; border-radius: 20px; font-size: 12px; color: white; font-weight: bold; }
    .b-pending { background: #f59e0b; } .b-confirmed { background: #10b981; } .b-cancelled { background: #ef4444; }
  </style>
</head>
<body>
  <div id="loginScreen" style="display:flex; width:100%; justify-content:center; align-items:center; flex-direction:column;">
    <div class="clay-card" style="width: 300px; text-align:center;">
      <h2>Admin Login</h2>
      <form id="loginForm">
        <input type="email" id="lEmail" class="clay-input" placeholder="Admin Email" required>
        <input type="password" id="lPass" class="clay-input" placeholder="Password" required>
        <button type="submit" class="clay-btn" style="width:100%;">Login</button>
      </form>
      <p id="lError" style="color:red; font-size:14px;"></p>
    </div>
  </div>

  <div id="dashScreen" class="hidden" style="width:100%; display:flex;">
    <div class="sidebar">
      <h2 style="color:var(--primary);">🦷 Admin</h2>
      <div class="nav-item active" onclick="nav('overview')">Overview</div>
      <div class="nav-item" onclick="nav('appointments')">Appointments</div>
      <div class="nav-item" onclick="nav('services')">Services</div>
      <div class="nav-item" onclick="nav('dentists')">Dentists</div>
      <div class="nav-item" onclick="logout()" style="margin-top:auto; background:#ef4444; color:white;">Logout</div>
    </div>
    <div class="main" id="mainContent"></div>
  </div>

  <script src="/admin.js"></script>
</body>
</html>
`;

app.get('/admin', (req, res) => res.send(adminHTML));
app.get('/admin.js', (req, res) => res.sendFile(path.join(__dirname, 'admin.js')));

// 404 & Internal Error Fallback
app.use((req, res) => res.status(404).json({ error: 'Route not found' }));
app.use((err, req, res, next) => {
  console.error('Express Error:', err);
  res.status(500).json({ error: 'Internal Server Error' });
});

if (process.env.NODE_ENV !== 'production') {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
