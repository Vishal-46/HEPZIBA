export type Role = 'doctor' | 'admin';

export type AuthUser = {
  id: number;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
  aadhaar?: string | null;
};

export type Session = {
  /** Short-lived access JWT. Sent as `Authorization: Bearer`. */
  token: string;
  /** Long-lived opaque refresh token (rotating). Never sent as Bearer. */
  refreshToken?: string;
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
  active?: boolean;
  aadhaar?: string | null;
  [key: string]: unknown;
};

export type PatientRow = {
  user_id: number;
  patient_id: number | null;
  name: string;
  email?: string;
  active?: boolean;
  patient_code?: string | null;
  age?: number | null;
  sex?: string | null;
  mobile?: string | null;
  bp?: string | null;
  spo2?: number | null;
  [key: string]: unknown;
};

export type InvoiceRow = {
  id: number;
  patient_id: number;
  appointment_id?: number | null;
  doctor_name?: string | null;
  total_amount: string | number;
  invoice_date?: string;
  patient_name?: string;
  patient_code?: string | null;
  [key: string]: unknown;
};

export type InventoryItem = {
  id: number;
  name: string;
  stock: number;
  reorder_level: number;
  unit: string;
  category?: string | null;
  mrp?: string | number | null;
  expiry_date?: string | null;
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

export type Patient = {
  id: number;
  patient_id?: number;
  user_id?: number;
  patient_code?: string;
  name: string;
  email?: string;
  age?: number | string;
  sex?: string;
  dob?: string;
  address?: string;
  mobile?: string;
  photo_url?: string;
  aadhar_number?: string;
  height_cm?: number | string;
  weight_kg?: number | string;
  bp?: string;
  spo2?: number | string;
  created_at?: string;
  appointments?: Appointment[];
  prescriptions?: unknown[];
  invoices?: Invoice[];
};

export type InvoiceItem = {
  id?: number;
  medicine_name: string;
  expiry_date?: string;
  unit?: string;
  mrp: number | string;
  quantity: number | string;
  total: number | string;
};

export type Invoice = {
  id: number;
  patient_id: number;
  patient_name?: string;
  patient_code?: string;
  patient_age?: number;
  patient_sex?: string;
  patient_mobile?: string;
  patient_address?: string;
  patient_aadhar?: string;
  appointment_id?: number | null;
  doctor_name?: string;
  invoice_date?: string;
  total_amount: number | string;
  status?: string;
  items?: InvoiceItem[];
};

