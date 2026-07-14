import { useCallback, useEffect, useMemo, useState } from 'react';
import { TouchableOpacity } from 'react-native';
import { useNavigation } from '@react-navigation/native';
import {
  Button,
  Card,
  Chip,
  IconButton,
  Surface,
  Text,
  TextInput,
  TouchableRipple,
} from 'react-native-paper';
import DateTimePicker from '@react-native-community/datetimepicker';
import { API_BASE_URL } from '../config/api';
import FormField from '../components/FormField';
import { COLOR, FONT, RADIUS, SHADOW, SPACING } from '../../theme';

type User = { id: number; name: string; email: string; role: 'patient' | 'doctor' | 'admin' };

type Appointment = {
  id: number;
  scheduled_at?: string;
  scheduled_at_effective?: string;
  date_time?: string;
  status: 'pending' | 'confirmed' | 'done' | 'cancelled';
  reason?: string;
  doctor_name?: string;
  token_number?: number;
};

type Doctor = { doctor_id: number; name: string; specialty?: string };

type PatientProfile = {
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

type Prescription = { id: number; doctor_name?: string; prescribed_on?: string; items: Array<{ medicine_name: string }> };
type Invoice = { id: number; invoice_date?: string; total_amount?: number; status?: string };

type Props = { token: string; user: User; onLogout: () => void };
type TabKey = 'home' | 'book' | 'records' | 'profile' | 'clinic';

const PRIORITY_OPTIONS = ['normal', 'urgent'];
const CLINIC_DETAILS = {
  name: 'Hepziba Chest Clinic',
  doctor: 'Dr. T. Joseph Pratheeban, DCH, MD (Respiratory Medicine)',
  specialty: 'Pulmonologist & Bronchoscopist',
  address: 'Opposite to WCC Entrance, White House Street, Nagercoil',
  mobile: '9500907968',
};

const CLINIC_HIGHLIGHTS = [
  'Specialist chest and respiratory care',
  'Friendly appointment system with token number',
  'Your records and prescriptions in one place',
];

const HOW_TO_USE = [
  'Book Appointment: pick a doctor and time, add your reason and symptoms.',
  'Consult Doctor: visit the clinic at your token time for consultation.',
  'View Records: check appointments, prescriptions, and bills anytime.',
  'Update Profile: keep your contact and health details updated.',
];

const BEFORE_VISIT = [
  'Bring any previous reports or test results.',
  'Keep your phone number active for updates.',
  'Arrive a little early for smooth check-in.',
];

import { createBottomTabNavigator } from '@react-navigation/bottom-tabs';
import { createStackNavigator } from '@react-navigation/stack';
import { useNavigation } from '@react-navigation/native';
import PrescriptionDetailScreen from './PrescriptionDetailScreen';
import InvoiceDetailScreen from './InvoiceDetailScreen';

const Stack = createStackNavigator();
const TabNav = createBottomTabNavigator();

export default function PatientHomeScreen(props: Props) {
  return (
    <Stack.Navigator screenOptions={{ headerShown: false }}>
      <Stack.Screen name="Tabs">
        {(screenProps) => (
          <TabNav.Navigator
            screenOptions={({ route }) => ({
              tabBarIcon: ({ color, size }) => {
                let iconName = "home";
                if (route.name === "HomeTab") iconName = "home";
                return <IconButton icon={iconName} iconColor={color} size={size} />;
              },
              tabBarActiveTintColor: COLOR.primary,
              tabBarInactiveTintColor: COLOR.accent,
              headerShown: false,
            })}
          >
            <TabNav.Screen name="HomeTab" children={() => <PatientHomeScreenContent {...props} />} />
          </TabNav.Navigator>
        )}
      </Stack.Screen>
      <Stack.Screen name="PrescriptionDetail" component={PrescriptionDetailScreen} options={{ title: 'Prescription', headerShown: true }} />
      <Stack.Screen name="InvoiceDetail" component={InvoiceDetailScreen} options={{ title: 'Invoice', headerShown: true }} />
    </Stack.Navigator>
  );
}

function PatientHomeScreenContent({ token, user, onLogout }: Props) {
  const navigation = useNavigation<any>();
  const topInset = Platform.OS === "android" ? (StatusBar.currentHeight || 0) : 0;
  const [tab, setTab] = useState<TabKey>("home");
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [doctors, setDoctors] = useState<Doctor[]>([]);
  const [profile, setProfile] = useState<PatientProfile | null>(null);
  const [prescriptions, setPrescriptions] = useState<Prescription[]>([]);
  const [invoices, setInvoices] = useState<Invoice[]>([]);

  const [loading, setLoading] = useState(false);
  const [errorText, setErrorText] = useState('');
  const [infoText, setInfoText] = useState('');

  const [showBookModal, setShowBookModal] = useState(false);
  const [selectedDoctorId, setSelectedDoctorId] = useState<number | null>(null);
  const [reasonInput, setReasonInput] = useState('Respiratory consultation');
  const [symptomsInput, setSymptomsInput] = useState('');
  const [priorityInput, setPriorityInput] = useState('normal');
  const [appointmentDate, setAppointmentDate] = useState(new Date());
  const [showDatePicker, setShowDatePicker] = useState(false);
  const [showTimePicker, setShowTimePicker] = useState(false);

  const [profileDraft, setProfileDraft] = useState<Record<string, string>>({
    name: '', email: '', age: '', sex: '', address: '', mobile: '', aadhar_number: '', height_cm: '', weight_kg: '', bp: '', spo2: '',
  });

  const apiGet = useCallback(async (url: string) => {
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    const payload = await safeJson(response);
    if (!response.ok) throw new Error(payload?.error ?? 'Request failed');
    return payload;
  }, [token]);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      const [apps, docs, me, rx, bills] = await Promise.allSettled([
        apiGet(`${API_BASE_URL}/appointments/my`),
        apiGet(`${API_BASE_URL}/appointments/catalog/doctors`),
        apiGet(`${API_BASE_URL}/patients/me`),
        apiGet(`${API_BASE_URL}/prescriptions/my`),
        apiGet(`${API_BASE_URL}/billing/my`),
      ]);

      const appsData = apps.status === 'fulfilled' && Array.isArray(apps.value) ? apps.value : [];
      const docsData = docs.status === 'fulfilled' && Array.isArray(docs.value) ? docs.value : [];
      const meData = me.status === 'fulfilled' ? me.value : null;
      const rxData = rx.status === 'fulfilled' && Array.isArray(rx.value) ? rx.value : [];
      const billsData = bills.status === 'fulfilled' && Array.isArray(bills.value) ? bills.value : [];

      setAppointments(appsData);
      setDoctors(docsData);
      setProfile(meData || null);
      setPrescriptions(rxData);
      setInvoices(billsData);

      if (rx.status === 'rejected') {
        setInfoText('Prescriptions are temporarily unavailable. Other sections are still working.');
      }

      if (meData) {
        setProfileDraft({
          name: meData.name || '', email: meData.email || '', age: meData.age ? String(meData.age) : '', sex: meData.sex || '', address: meData.address || '',
          mobile: meData.mobile || '', aadhar_number: meData.aadhar_number || '', height_cm: meData.height_cm ? String(meData.height_cm) : '',
          weight_kg: meData.weight_kg ? String(meData.weight_kg) : '', bp: meData.bp || '', spo2: meData.spo2 ? String(meData.spo2) : '',
        });
      }
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Failed to load data');
    } finally {
      setLoading(false);
    }
  }, [apiGet]);

  useEffect(() => { loadAll(); }, [loadAll]);

  useEffect(() => {
    const now = new Date();
    const rounded = new Date(now);
    rounded.setMinutes(now.getMinutes() + (30 - (now.getMinutes() % 30)));
    rounded.setSeconds(0);
    rounded.setMilliseconds(0);
    if (appointmentDate.getTime() < now.getTime()) {
      setAppointmentDate(rounded);
    }
  }, [appointmentDate]);

  const nextAppointment = useMemo(() => {
    const now = Date.now();
    return appointments
      .filter((a) => getAppointmentDate(a)?.getTime() && (getAppointmentDate(a)?.getTime() || 0) >= now && a.status !== 'done' && a.status !== 'cancelled')
      .sort((a, b) => (getAppointmentDate(a)?.getTime() || 0) - (getAppointmentDate(b)?.getTime() || 0))[0];
  }, [appointments]);

  const selectedDoctor = doctors.find((d) => d.doctor_id === selectedDoctorId) || null;

  const submitBooking = async () => {
    if (!selectedDoctorId) return setErrorText('Please select a doctor first.');
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      if (!PRIORITY_OPTIONS.includes(priorityInput.trim().toLowerCase())) {
        throw new Error('Priority must be normal or urgent');
      }

      const profileContext = profile
        ? `Age:${profile.age || '-'} Sex:${profile.sex || '-'} BP:${profile.bp || '-'} SpO2:${profile.spo2 || '-'} Mobile:${profile.mobile || '-'}`
        : '';
      const notes = `Priority:${priorityInput}; Symptoms:${symptomsInput || '-'}; ${profileContext}`;

      const response = await fetch(`${API_BASE_URL}/appointments/`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          doctor_id: selectedDoctorId,
          scheduled_at: appointmentDate.toISOString(),
          reason: reasonInput.trim() || 'Respiratory consultation',
          notes,
        }),
      });
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error ?? 'Booking failed');

      setInfoText(`Appointment booked with ${selectedDoctor?.name || 'doctor'}. Token #${payload.appointment?.token_number || '-'}`);
      setShowBookModal(false);
      await loadAll();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Booking failed');
    } finally {
      setLoading(false);
    }
  };

  const saveProfile = async () => {
    setLoading(true);
    setErrorText('');
    setInfoText('');
    try {
      if (profileDraft.mobile && !/^\d{10,15}$/.test(profileDraft.mobile)) {
        throw new Error('Mobile must be 10-15 digits');
      }
      if (profileDraft.aadhar_number && !/^\d{12}$/.test(profileDraft.aadhar_number)) {
        throw new Error('Aadhar must be exactly 12 digits');
      }
      if (profileDraft.spo2) {
        const spo2 = Number(profileDraft.spo2);
        if (Number.isNaN(spo2) || spo2 < 0 || spo2 > 100) throw new Error('SpO2 must be between 0 and 100');
      }

      const response = await fetch(`${API_BASE_URL}/patients/me`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
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
      const payload = await safeJson(response);
      if (!response.ok) throw new Error(payload?.error ?? 'Profile update failed');
      setInfoText('Profile updated successfully.');
      await loadAll();
    } catch (error) {
      setErrorText(error instanceof Error ? error.message : 'Profile update failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <SafeAreaView style={s.container}>
      <Surface style={[s.headerRow, { paddingTop: topInset + SPACING.s }]}>
        <View style={s.headerTextWrap}>
          <Text style={s.heading}>Hello, {profile?.name || user.name}</Text>
          <Text style={s.subHeading}>{profile?.patient_code || 'Patient dashboard'}</Text>
        </View>
        <Button mode="contained" onPress={onLogout} style={s.logoutBtn} labelStyle={s.logoutText}>Log out</Button>
      </Surface>

      {!!infoText && <Text style={s.infoText}>{infoText}</Text>}
      {!!errorText && <Text style={s.errorText}>{errorText}</Text>}

      <ScrollView contentContainerStyle={s.scrollBody}>
        {loading && <ActivityIndicator color={COLOR.primary} style={{ marginBottom: SPACING.s }} />}

        {tab === 'home' && (
          <>
            <Card style={s.card}>
              <Card.Content>
                <Text style={s.cardLabel}>Next Appointment</Text>
                {nextAppointment ? (
                  <>
                    <Text style={s.cardTitle}>{formatDate(nextAppointment)}</Text>
                    <Text style={s.cardMeta}>Doctor: {nextAppointment.doctor_name || 'Assigned doctor'}</Text>
                    <Text style={s.cardMeta}>Token: #{nextAppointment.token_number || '-'}</Text>
                    <Text style={s.cardMeta}>Status: {nextAppointment.status}</Text>
                  </>
                ) : (
                  <Text style={s.cardMeta}>No upcoming appointments.</Text>
                )}
              </Card.Content>
            </Card>
            <View style={s.quickActions}>
              <Button mode="contained" onPress={() => setShowBookModal(true)} style={[s.primaryBtn, s.fullWidthButton]} labelStyle={s.primaryBtnText}>Book Appointment</Button>
              <Button mode="outlined" onPress={() => setTab('records')} style={[s.secondaryBtn, s.fullWidthButton]} labelStyle={s.secondaryBtnText}>View Records</Button>
              <Button mode="outlined" onPress={() => setTab('clinic')} style={[s.secondaryBtn, s.fullWidthButton]} labelStyle={s.secondaryBtnText}>Clinic Details</Button>
            </View>
          </>
        )}


        {tab === 'book' && (
          <Card style={s.card}>
            <Card.Content>
              <Text style={s.cardTitle}>Choose Doctor</Text>
              {doctors.length ? doctors.map((doctor) => (
                <TouchableRipple
                  key={doctor.doctor_id}
                  onPress={() => setSelectedDoctorId(doctor.doctor_id)}
                  style={[s.doctorChip, selectedDoctorId === doctor.doctor_id && s.doctorChipActive]}
                >
                  <View style={{padding: SPACING.m}}>
                    <Text style={s.doctorChipTitle}>{doctor.name}</Text>
                    <Text style={s.doctorChipMeta}>{doctor.specialty || 'General consultation'}</Text>
                  </View>
                </TouchableRipple>
              )) : <Text style={s.cardMeta}>No doctors listed.</Text>}

              <View style={s.datetimeRow}>
                <Button mode="outlined" style={s.flexButton} onPress={() => setShowDatePicker(true)}>Pick Date</Button>
                <Button mode="outlined" style={s.flexButton} onPress={() => setShowTimePicker(true)}>Pick Time</Button>
              </View>
              <Text style={s.cardMeta}>Selected: {appointmentDate.toLocaleString()}</Text>

              <FormField label="Reason" value={reasonInput} onChangeText={setReasonInput} />
              <FormField label="Symptoms" value={symptomsInput} onChangeText={setSymptomsInput} multiline />
              <View style={s.priorityRow}>
                {PRIORITY_OPTIONS.map((item) => (
                  <Chip
                    key={item}
                    selected={priorityInput === item}
                    onPress={() => setPriorityInput(item)}
                    style={{marginRight: SPACING.s}}
                  >
                    {item.toUpperCase()}
                  </Chip>
                ))}
              </View>
              <Button mode="contained" onPress={submitBooking} style={s.primaryBtn} labelStyle={s.primaryBtnText}>Confirm Booking</Button>
            </Card.Content>
          </Card>
        )}

        {tab === 'records' && (
          <>
            <SectionCard title="Appointments">
              {appointments.length ? appointments.map((app) => (
                <Card key={app.id} style={{marginBottom: SPACING.s}}>
                  <Card.Content>
                    <Text style={s.rowTitle}>{formatDate(app)}</Text>
                    <Text style={s.rowMeta}>Doctor: {app.doctor_name || '-'}</Text>
                    <Text style={s.rowMeta}>Token: #{app.token_number || '-'}</Text>
                    <Text style={s.rowMeta}>Status: {app.status}</Text>
                  </Card.Content>
                </Card>
              )) : <Text style={s.rowMeta}>No appointments yet.</Text>}
            </SectionCard>

            <SectionCard title="Prescriptions">
              {prescriptions.length ? prescriptions.map((p) => (
                <TouchableOpacity key={p.id} onPress={() => navigation.navigate('PrescriptionDetail', { prescription: p })}>
                  <Card style={{marginBottom: SPACING.s}}>
                    <Card.Content>
                      <Text style={s.rowTitle}>{p.doctor_name || 'Doctor'}</Text>
                      <Text style={s.rowMeta}>{p.prescribed_on ? new Date(p.prescribed_on).toLocaleString() : ''}</Text>
                      <Text style={s.rowMeta}>{p.items.map((i) => i.medicine_name).join(', ') || 'No items'}</Text>
                    </Card.Content>
                  </Card>
                </TouchableOpacity>
              )) : <Text style={s.rowMeta}>No prescriptions yet.</Text>}
            </SectionCard>

            <SectionCard title="Invoices">
              {invoices.length ? invoices.map((invoice) => (
                <TouchableOpacity key={invoice.id} onPress={() => navigation.navigate('InvoiceDetail', { invoice: invoice })}>
                  <Card style={{marginBottom: SPACING.s}}>
                    <Card.Content>
                      <Text style={s.rowTitle}>Invoice #{invoice.id}</Text>
                      <Text style={s.rowMeta}>{invoice.invoice_date ? new Date(invoice.invoice_date).toLocaleDateString() : ''}</Text>
                      <Text style={s.rowMeta}>Amount: Rs {Number(invoice.total_amount || 0).toFixed(2)}</Text>
                      <Text style={s.rowMeta}>Status: {invoice.status || 'unpaid'}</Text>
                    </Card.Content>
                  </Card>
                </TouchableOpacity>
              )) : <Text style={s.rowMeta}>No invoices yet.</Text>}
            </SectionCard>
          </>
        )}

        {tab === 'profile' && (
          <Card style={s.card}>
            <Card.Content>
              <Text style={s.cardTitle}>Patient Details</Text>
              <FormField label="Name" value={profileDraft.name} onChangeText={(v) => updateDraft(setProfileDraft, 'name', v)} />
              <FormField label="Email" value={profileDraft.email} onChangeText={(v) => updateDraft(setProfileDraft, 'email', v)} keyboardType="email-address" />
              <FormField label="Age" value={profileDraft.age} onChangeText={(v) => updateDraft(setProfileDraft, 'age', v)} keyboardType="numeric" />
              <FormField label="Sex" value={profileDraft.sex} onChangeText={(v) => updateDraft(setProfileDraft, 'sex', v)} />
              <FormField label="Address" value={profileDraft.address} onChangeText={(v) => updateDraft(setProfileDraft, 'address', v)} />
              <FormField label="Mobile" value={profileDraft.mobile} onChangeText={(v) => updateDraft(setProfileDraft, 'mobile', v)} keyboardType="phone-pad" />
              <FormField label="Aadhar" value={profileDraft.aadhar_number} onChangeText={(v) => updateDraft(setProfileDraft, 'aadhar_number', v)} keyboardType="numeric" />
              <FormField label="Height (cm)" value={profileDraft.height_cm} onChangeText={(v) => updateDraft(setProfileDraft, 'height_cm', v)} keyboardType="numeric" />
              <FormField label="Weight (kg)" value={profileDraft.weight_kg} onChangeText={(v) => updateDraft(setProfileDraft, 'weight_kg', v)} keyboardType="numeric" />
              <FormField label="BP" value={profileDraft.bp} onChangeText={(v) => updateDraft(setProfileDraft, 'bp', v)} />
              <FormField label="SpO2" value={profileDraft.spo2} onChangeText={(v) => updateDraft(setProfileDraft, 'spo2', v)} keyboardType="numeric" />
              <Button mode="contained" onPress={saveProfile} style={s.primaryBtn} labelStyle={s.primaryBtnText}>Save Profile</Button>
            </Card.Content>
          </Card>
        )}

        {tab === 'clinic' && (
          <>
            <Card style={s.card}>
              <Card.Content>
                <Text style={s.cardTitle}>About the Clinic</Text>
                <Text style={s.rowTitle}>{CLINIC_DETAILS.name}</Text>
                <Text style={s.rowMeta}>{CLINIC_DETAILS.specialty}</Text>
                <Text style={s.rowMeta}>Doctor: {CLINIC_DETAILS.doctor}</Text>
                <Text style={s.rowMeta}>Address: {CLINIC_DETAILS.address}</Text>
                <Text style={s.rowMeta}>Mobile: {CLINIC_DETAILS.mobile}</Text>
              </Card.Content>
            </Card>

            <SectionCard title="Why Patients Choose Us">
              <InfoList items={CLINIC_HIGHLIGHTS} />
            </SectionCard>

            <SectionCard title="How to Use This App">
              <InfoList items={HOW_TO_USE} />
            </SectionCard>

            <SectionCard title="Before You Visit">
              <InfoList items={BEFORE_VISIT} />
            </SectionCard>
          </>
        )}
      </ScrollView>

      <View style={s.bottomTabs}>
        <Tab label="Home" active={tab === 'home'} onPress={() => setTab('home')} />
        <Tab label="Book" active={tab === 'book'} onPress={() => setTab('book')} />
        <Tab label="Records" active={tab === 'records'} onPress={() => setTab('records')} />
        <Tab label="Profile" active={tab === 'profile'} onPress={() => setTab('profile')} />
        <Tab label="Clinic" active={tab === 'clinic'} onPress={() => setTab('clinic')} />
      </View>

      <Modal visible={showBookModal} transparent animationType="slide">
        <View style={s.modalWrap}>
          <Card style={s.modalCard}>
            <Card.Content>
              <Text style={s.cardTitle}>Book Appointment</Text>
              <Text style={s.cardMeta}>Open full booking to choose doctor, date, and notes.</Text>
              <Button mode="contained" onPress={() => { setTab('book'); setShowBookModal(false); }} style={s.primaryBtn} labelStyle={s.primaryBtnText}>Open Booking</Button>
              <Button mode="outlined" onPress={() => setShowBookModal(false)} style={s.secondaryBtn} labelStyle={s.secondaryBtnText}>Close</Button>
            </Card.Content>
          </Card>
        </View>
      </Modal>

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableRipple style={s.tab} onPress={onPress}>
      <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
    </TouchableRipple>
  );
}

          }}
        />
      )}
    </SafeAreaView>
  );
}

function updateDraft(setter: React.Dispatch<React.SetStateAction<Record<string, string>>>, key: string, value: string) {
  setter((prev) => ({ ...prev, [key]: value }));
}

function SectionCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Card style={s.card}>
      <Card.Content>
        <Text style={s.cardTitle}>{title}</Text>
        {children}
      </Card.Content>
    </Card>
  );
}

function InfoList({ items }: { items: string[] }) {
  return (
    <View>
      {items.map((item) => (
        <Text key={item} style={s.rowMeta}>{`- ${item}`}</Text>
      ))}
    </View>
  );
}

function Tab({ label, active, onPress }: { label: string; active: boolean; onPress: () => void }) {
  return (
    <TouchableRipple style={s.tab} onPress={onPress}>
      <Text style={[s.tabText, active && s.tabActive]}>{label}</Text>
    </TouchableRipple>
  );
}

function getAppointmentDate(app: Appointment): Date | null {
  const raw = app.scheduled_at_effective || app.scheduled_at || app.date_time;
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function formatDate(app: Appointment): string {
  const d = getAppointmentDate(app);
  return d ? d.toLocaleString() : 'Date unavailable';
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
    paddingBottom: SPACING.m,
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  headerTextWrap: { flex: 1, paddingRight: SPACING.s },
  heading: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 24 },
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
  quickActions: { flexDirection: 'column', gap: SPACING.s, marginBottom: SPACING.m },
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
  datetimeRow: { flexDirection: 'row', gap: SPACING.s },
  priorityRow: {
    flexDirection: 'row',
    gap: SPACING.s,
    marginTop: SPACING.s,
  },
  priorityChip: {
    flex: 1,
    paddingVertical: SPACING.s,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLOR.accent,
    alignItems: 'center',
    backgroundColor: COLOR.surface,
  },
  priorityChipActive: {
    backgroundColor: COLOR.primary,
    borderColor: COLOR.primary,
  },
  priorityChipText: {
    color: COLOR.primary,
    fontFamily: FONT.medium,
    fontSize: 13,
  },
  priorityChipTextActive: {
    color: COLOR.surface,
    fontFamily: FONT.bold,
  },
  flexButton: { flex: 1 },
  fullWidthButton: { width: '100%' },
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
  modalWrap: { flex: 1, backgroundColor: 'rgba(47,52,65,0.28)', justifyContent: 'flex-end', padding: SPACING.l },
  modalCard: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.l, ...SHADOW.card },
});
