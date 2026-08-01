CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('patient','doctor','admin')),
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE patients (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  dob DATE,
  allergies TEXT,
  contact TEXT,
  address TEXT
);

CREATE TABLE appointments (
  id SERIAL PRIMARY KEY,
  patient_id INTEGER REFERENCES patients(id) ON DELETE CASCADE,
  doctor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  date_time TIMESTAMP NOT NULL,
  status TEXT DEFAULT 'pending',
  reason TEXT,
  notes TEXT
);
