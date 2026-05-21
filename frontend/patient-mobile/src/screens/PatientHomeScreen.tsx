import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Modal,
  SafeAreaView,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { API_BASE_URL } from '../config/api';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';

type User = {
  id: number;
  name: string;
  email: string;
  role: 'patient' | 'doctor' | 'admin';
};

type Appointment = {
  id: number;
  scheduled_at?: string;
  status: 'pending' | 'confirmed' | 'done' | 'cancelled';
  reason?: string;
  doctor_name?: string;
  token_number?: number;
};

type Doctor = {
  doctor_id: number;
  name: string;
  specialty?: string;
};

type PatientProfile = {
  patient_id?: number;
  patient_code?: string;
  name: string;
  email: string;
  age?: number;
  sex?: string;
  address?: string;
  mobile?: string;
  aadhar_number?: string;
  height_cm?: number;
  weight_kg?: number;
  bp?: string;
  spo2?: number;
};

type Prescription = {
  id: number;
  doctor_name?: string;
  prescribed_on?: string;
  notes?: string;
  items: Array<{
    id: number;
    medicine_name: string;
    dosage_morning: boolean;
    dosage_afternoon: boolean;
    dosage_evening: boolean;
    dosage_night: boolean;
    before_food: boolean;
    after_food: boolean;
  }>;
};

type Invoice = {
  id: number;
  invoice_date?: string;
  total_amount?: number;
  status?: string;
  items: Array<{ id: number; medicine_name: string; quantity: number; mrp: number; total: number }>;
};

type Props = {
  token: string;
  user: User;
  onLogout: () => void;
};

type TabKey = 'home' | 'book' | 'records' | 'profile';

export default function PatientHomeScreen({ token, user, onLogout }: Props) {
  const [tab, setTab] = useState<TabKey>('home');

  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [isBusy, setIsBusy] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');

  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [scheduleInput, setScheduleInput] = useState('');
  const [reasonInput, setReasonInput] = useState('');

  const [profileDraft, setProfileDraft] = useState({
    name: '',
    email: '',
    age: '',
    sex: '',
    address: '',
    mobile: '',
    aadhar_number: '',
    height_cm: '',
    weight_kg: '',
    bp: '',
    spo2: '',
  });

  const run = useCallback(
    async <T,>(request: () => Promise<T>): Promise<T | null> => {
      setIsBusy(true);
      setErrorText('');
      try {
        return await request();
      } catch (error) {
        setErrorText(error instanceof Error ? error.message : 'Request failed');
        return null;
      } finally {
        setIsBusy(false);
      }
    },
    []
  );

  const apiGet = useCallback(
    async (url: string) => {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error ?? 'Request failed');
      return payload;
    },
    [token]
  );

  const loadAll = useCallback(async () => {
    const [apps, docs, me, rx, bills] = await Promise.all([
      apiGet(`${API_BASE_URL}/appointments/my`),
      apiGet(`${API_BASE_URL}/appointments/catalog/doctors`),
      apiGet(`${API_BASE_URL}/patients/me`),
      apiGet(`${API_BASE_URL}/prescriptions/my`),
      apiGet(`${API_BASE_URL}/billing/my`),
    ]);

    setAppointments(Array.isArray(apps) ? apps : []);
    setDoctors(Array.isArray(docs) ? docs : []);
    setProfile(me || null);
    setPrescriptions(Array.isArray(rx) ? rx : []);
    setInvoices(Array.isArray(bills) ? bills : []);

    if (me) {
      setProfileDraft({
        name: me.name || '',
        email: me.email || '',
        age: me.age ? String(me.age) : '',
        sex: me.sex || '',
        address: me.address || '',
        mobile: me.mobile || '',
        aadhar_number: me.aadhar_number || '',
        height_cm: me.height_cm ? String(me.height_cm) : '',
        weight_kg: me.weight_kg ? String(me.weight_kg) : '',
        bp: me.bp || '',
        spo2: me.spo2 ? String(me.spo2) : '',
      });
    }
  }, [apiGet]);

  useEffect(() => {
    run(loadAll);
  }, [loadAll, run]);

  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return appointments
      .filter((a) => !!a.scheduled_at && new Date(a.scheduled_at).getTime() >= now && a.status !== 'done' && a.status !== 'cancelled')
      .sort((a, b) => new Date(a.scheduled_at || '').getTime() - new Date(b.scheduled_at || '').getTime())[0];
  }, [appointments]);

  const submitBooking = async () => {
    if (!selectedDoctorId || !scheduleInput.trim()) {
      setErrorText('Select doctor and schedule to book appointment.');
      return;
    }

    const response = await run(async () => {
      const rawDate = new Date(scheduleInput);
      if (Number.isNaN(rawDate.getTime())) throw new Error('Use valid date-time format (YYYY-MM-DD HH:mm)');

      const res = await fetch(`${API_BASE_URL}/appointments/`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          doctor_id: selectedDoctorId,
          scheduled_at: rawDate.toISOString(),
          reason: reasonInput.trim() || undefined,
        }),
      });

      const payload = await safeJson(res);
      if (!res.ok) throw new Error(payload?.error ?? 'Booking failed');
      return payload;
    });

    if (response) {
      setInfoText(`Appointment booked. Token #${response.appointment?.token_number ?? '-'}`);
      setShowBookModal(false);
      setReasonInput('');
      setScheduleInput('');
      await run(loadAll);
    }
  };

  const saveProfile = async () => {
    const result = await run(async () => {
      const res = await fetch(`${API_BASE_URL}/patients/me`, {
        method: 'PUT',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({
          name: profileDraft.name,
          email: profileDraft.email,
          age: profileDraft.age ? Number(profileDraft.age) : undefined,
          sex: profileDraft.sex || undefined,
          address: profileDraft.address || undefined,
          mobile: profileDraft.mobile || undefined,
          aadhar_number: profileDraft.aadhar_number || undefined,
          height_cm: profileDraft.height_cm ? Number(profileDraft.height_cm) : undefined,
          weight_kg: profileDraft.weight_kg ? Number(profileDraft.weight_kg) : undefined,
          bp: profileDraft.bp || undefined,
          spo2: profileDraft.spo2 ? Number(profileDraft.spo2) : undefined,
        }),
      });

      const payload = await safeJson(res);
      if (!res.ok) throw new Error(payload?.error ?? 'Profile update failed');
      return payload;
    });

    if (result) {
      setInfoText('Profile updated successfully.');
      await run(loadAll);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <View style={s.headerRow}>
        <View>
          <Text style={s.heading}>Hepziba Patient Care</Text>
          <Text style={s.subHeading}>{profile?.patient_code || 'Patient'}</Text>
        </View>
        <TouchableOpacity style={s.logoutBtn} onPress={onLogout} activeOpacity={0.8}>
          <Text style={s.logoutText}>Log out</Text>
        </TouchableOpacity>
      </View>

      {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
      {!!errorText && <Text style={s.errorText}>{errorText}</Text>}

      <ScrollView contentContainerStyle={s.scrollBody}>
        {tab === 'home' && (
          <>
            <View style={s.card}>
              <Text style={s.cardLabel}>Next Appointment</Text>
              {isBusy ? (
                <ActivityIndicator color={COLOR.primary} />
              ) : nextAppointment ? (
                <>
                  <Text style={s.cardTitle}>{new Date(nextAppointment.scheduled_at || '').toLocaleString()}</Text>
                  <Text style={s.cardMeta}>Doctor: {nextAppointment.doctor_name || 'Assigned'}</Text>
                  <Text style={s.cardMeta}>Token: #{nextAppointment.token_number || '-'}</Text>
                  <Text style={s.cardMeta}>Status: {nextAppointment.status}</Text>
                </>
              ) : (
                <Text style={s.cardMeta}>No upcoming appointments.</Text>
              )}
            </View>

            <View style={s.quickActions}>
              <TouchableOpacity style={s.primaryBtn} onPress={() => setShowBookModal(true)} activeOpacity={0.85}>
                <Text style={s.primaryBtnText}>Book Appointment</Text>
              </TouchableOpacity>
              <TouchableOpacity style={s.secondaryBtn} onPress={() => setTab('records')} activeOpacity={0.85}>
                <Text style={s.secondaryBtnText}>View Records</Text>
              </TouchableOpacity>
            </View>
          </>
        )}

        {tab === 'book' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Available Doctors</Text>
            {doctors.length ? (
              doctors.map((doctor) => (
                <TouchableOpacity
                  key={doctor.doctor_id}
                  onPress={() => setSelectedDoctorId(doctor.doctor_id)}
                  style={[
                    s.doctorChip,
                    selectedDoctorId === doctor.doctor_id && s.doctorChipActive,
                  ]}
                  activeOpacity={0.8}
                >
                  <Text style={s.doctorChipTitle}>{doctor.name}</Text>
                  <Text style={s.doctorChipMeta}>{doctor.specialty || 'General Consultation'}</Text>
                </TouchableOpacity>
              ))
            ) : (
              <Text style={s.cardMeta}>No doctors listed.</Text>
            )}

            <InputField label="Schedule (YYYY-MM-DD HH:mm)" value={scheduleInput} onChangeText={setScheduleInput} />
            <InputField label="Reason" value={reasonInput} onChangeText={setReasonInput} />
            <TouchableOpacity style={s.primaryBtn} onPress={submitBooking} activeOpacity={0.85}>
              <Text style={s.primaryBtnText}>Confirm Booking</Text>
            </TouchableOpacity>
          </View>
        )}

        {tab === 'records' && (
          <>
            <SectionCard title="Appointments">
              {appointments.map((app) => (
                <View key={app.id} style={s.rowItem}>
                  <Text style={s.rowTitle}>{new Date(app.scheduled_at || '').toLocaleString()}</Text>
                  <Text style={s.rowMeta}>Doctor: {app.doctor_name || '-'}</Text>
                  <Text style={s.rowMeta}>Token: #{app.token_number || '-'}</Text>
                  <Text style={s.rowMeta}>Status: {app.status}</Text>
                </View>
              ))}
            </SectionCard>

            <SectionCard title="Prescriptions">
              {prescriptions.length ? (
                prescriptions.map((p) => (
                  <View key={p.id} style={s.rowItem}>
                    <Text style={s.rowTitle}>{p.doctor_name || 'Doctor'}</Text>
                    <Text style={s.rowMeta}>{p.prescribed_on ? new Date(p.prescribed_on).toLocaleString() : ''}</Text>
                    <Text style={s.rowMeta}>{p.items.map((it) => it.medicine_name).join(', ') || 'No items'}</Text>
                  </View>
                ))
              ) : (
                <Text style={s.rowMeta}>No prescriptions yet.</Text>
              )}
            </SectionCard>

            <SectionCard title="Invoices">
              {invoices.length ? (
                invoices.map((invoice) => (
                  <View key={invoice.id} style={s.rowItem}>
                    <Text style={s.rowTitle}>Invoice #{invoice.id}</Text>
                    <Text style={s.rowMeta}>{invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString() : ''}</Text>
                    <Text style={s.rowMeta}>Amount: Rs {Number(invoice.total_amount || 0).toFixed(2)}</Text>
                    <Text style={s.rowMeta}>Status: {invoice.status || 'unpaid'}</Text>
                  </View>
                ))
              ) : (
                <Text style={s.rowMeta}>No invoices yet.</Text>
              )}
            </SectionCard>
          </>
        )}

        {tab === 'profile' && (
          <View style={s.card}>
            <Text style={s.cardTitle}>Patient Details</Text>
            <InputField label="Name" value={profileDraft.name} onChangeText={(v) => updateDraft(setProfileDraft, 'name', v)} />
            <InputField label="Email" value={profileDraft.email} onChangeText={(v) => updateDraft(setProfileDraft, 'email', v)} />
            <InputField label="Age" value={profileDraft.age} onChangeText={(v) => updateDraft(setProfileDraft, 'age', v)} keyboardType="numeric" />
            <InputField label="Sex" value={profileDraft.sex} onChangeText={(v) => updateDraft(setProfileDraft, 'sex', v)} />
            <InputField label="Address" value={profileDraft.address} onChangeText={(v) => updateDraft(setProfileDraft, 'address', v)} />
            <InputField label="Mobile" value={profileDraft.mobile} onChangeText={(v) => updateDraft(setProfileDraft, 'mobile', v)} keyboardType="phone-pad" />
            <InputField label="Aadhar" value={profileDraft.aadhar_number} onChangeText={(v) => updateDraft(setProfileDraft, 'aadhar_number', v)} keyboardType="numeric" />
            <InputField label="Height (cm)" value={profileDraft.height_cm} onChangeText={(v) => updateDraft(setProfileDraft, 'height_cm', v)} keyboardType="numeric" />
            <InputField label="Weight (kg)" value={profileDraft.weight_kg} onChangeText={(v) => updateDraft(setProfileDraft, 'weight_kg', v)} keyboardType="numeric" />
            <InputField label="BP" value={profileDraft.bp} onChangeText={(v) => updateDraft(setProfileDraft, 'bp', v)} />
            <InputField label="SpO2" value={profileDraft.spo2} onChangeText={(v) => updateDraft(setProfileDraft, 'spo2', v)} keyboardType="numeric" />

            <TouchableOpacity style={s.primaryBtn} onPress={saveProfile} activeOpacity={0.85}>
              <Text style={s.primaryBtnText}>Save Profile</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      <View style={s.bottomTabs}>
        <Tab label="Home" active={tab === 'home'} onPress={() => setTab('home')} />
        <Tab label="Book" active={tab === 'book'} onPress={() => setTab('book')} />
        <Tab label="Records" active={tab === 'records'} onPress={() => setTab('records')} />
        <Tab label="Profile" active={tab === 'profile'} onPress={() => setTab('profile')} />
      </View>

      <Modal visible={showBookModal} animationType="slide" transparent>
        <View style={s.modalWrap}>
          <View style={s.modalCard}>
            <Text style={s.cardTitle}>Quick Book</Text>
            <Text style={s.cardMeta}>Use Book tab for full doctor selection flow.</Text>
            <TouchableOpacity style={s.primaryBtn} onPress={() => { setTab('book'); setShowBookModal(false); }}>
              <Text style={s.primaryBtnText}>Open Booking</Text>
            </TouchableOpacity>
            <TouchableOpacity style={s.secondaryBtn} onPress={() => setShowBookModal(false)}>
              <Text style={s.secondaryBtnText}>Close</Text>
            </TouchableOpacity>
          </View>
        </View>
      </Modal>
    </SafeAreaView>
  );
}

function updateDraft(setter: any, key: string, value: string) {
  setter((prev: Record<string, string>) => ({ ...prev, [key]: value }));
}

function InputField({
  label,
  value,
  onChangeText,
  keyboardType,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  keyboardType?: 'default' | 'email-address' | 'numeric' | 'phone-pad';
}) {
  return (
    <View style={s.inputWrap}>
      <Text style={s.inputLabel}>{label}</Text>
      <TextInput
        style={s.input}
        value={value}
        onChangeText={onChangeText}
        keyboardType={keyboardType || 'default'}
        placeholderTextColor={COLOR.accent}
      />
    </View>
  );
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <View style={s.card}>
      <Text style={s.cardTitle}>{title}</Text>
      {children}
    </View>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableOpacity style={s.tab} onPress={onPress} activeOpacity={0.8}>
      <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
    </TouchableOpacity>
  );
}

async function safeJson(response: Response): Promise<any> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.background },
  headerRow: {
    paddingHorizontal: SPACING.l,
    paddingTop: SPACING.s,
    paddingBottom: SPACING.m,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  heading: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 22 },
  subHeading: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 14, marginTop: SPACING.xs },
  logoutBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    paddingHorizontal: SPACING.m,
    paddingVertical: SPACING.s,
    ...SHADOW.button,
  },
  logoutText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13 },
  scrollBody: { paddingHorizontal: SPACING.l, paddingBottom: 100 },
  card: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    marginBottom: SPACING.m,
    ...SHADOW.card,
  },
  cardLabel: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 13, marginBottom: SPACING.s },
  cardTitle: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 18, marginBottom: SPACING.s },
  cardMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  quickActions: { flexDirection: 'row', gap: SPACING.s, marginBottom: SPACING.m },
  primaryBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.m,
    marginTop: SPACING.s,
  },
  primaryBtnText: { color: COLOR.surface, fontFamily: FONT.bold, fontSize: 15 },
  secondaryBtn: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: SPACING.m,
    marginTop: SPACING.s,
    ...SHADOW.button,
  },
  secondaryBtnText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 15 },
  doctorChip: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    padding: SPACING.m,
    marginBottom: SPACING.s,
  },
  doctorChipActive: { backgroundColor: COLOR.background },
  doctorChipTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 15 },
  doctorChipMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 13, marginTop: SPACING.xs },
  rowItem: {
    borderTopWidth: 1,
    borderTopColor: COLOR.background,
    paddingTop: SPACING.s,
    marginTop: SPACING.s,
  },
  rowTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 15 },
  rowMeta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 13, marginTop: SPACING.xs },
  inputWrap: { marginBottom: SPACING.s },
  inputLabel: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13, marginBottom: SPACING.xs },
  input: {
    borderWidth: 1,
    borderColor: COLOR.accent,
    borderRadius: RADIUS.md,
    backgroundColor: COLOR.background,
    color: COLOR.text,
    fontFamily: FONT.regular,
    paddingHorizontal: SPACING.m,
    paddingVertical: 12,
    fontSize: 14,
  },
  bottomTabs: {
    position: 'absolute',
    left: SPACING.l,
    right: SPACING.l,
    bottom: SPACING.m,
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.s,
    flexDirection: 'row',
    ...SHADOW.card,
  },
  tab: { flex: 1, alignItems: 'center', paddingVertical: SPACING.s },
  tabText: { color: COLOR.primary, fontFamily: FONT.medium, fontSize: 12 },
  tabActive: { color: COLOR.text, fontFamily: FONT.bold },
  infoText: { color: COLOR.success, fontFamily: FONT.medium, fontSize: 13, marginHorizontal: SPACING.l, marginBottom: SPACING.xs },
  errorText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 13, marginHorizontal: SPACING.l, marginBottom: SPACING.xs },
  modalWrap: {
    flex: 1,
    backgroundColor: 'rgba(47,52,65,0.28)',
    justifyContent: 'flex-end',
    padding: SPACING.l,
  },
  modalCard: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.l,
    ...SHADOW.card,
  },
});
