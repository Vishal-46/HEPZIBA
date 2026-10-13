export type Role = 'doctor' | 'admin';

export type AuthUser = {
  id: number;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
  aadhaar?: string | null;
};

export type Session = {
  token: string;
  user: AuthUser;
};

export type Appointment = {
  id: number;
  patient_name?: string;
  patient_aadhaar?: string | null;
  aadhaar?: string | null;
  scheduled_at?: string;
  reason?: string;
  status?: string;
  notes?: string;
  [key: string]: unknown;
};

export type AdminUser = {
  id: number;
  name: string;
  email?: string;
  role: string;
  aadhaar?: string | null;
  [key: string]: unknown;
};

export type InventoryItem = {
  id: number;
  name: string;
  stock: number;
  reorder_level: number;
  unit: string;
  [key: string]: unknown;
};

export type MedicineRow = {
  name: string;
  m: boolean;
  a: boolean;
  e: boolean;
  n: boolean;
  bf: boolean;
  af: boolean;
};

export type ClinicHours = {
  openTime: string;
  closeTime: string;
  days: string;
  slotMinutes: string;
};
