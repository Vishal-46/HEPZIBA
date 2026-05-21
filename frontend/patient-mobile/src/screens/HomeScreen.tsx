import { View, Text, StyleSheet, SafeAreaView, TouchableOpacity } from 'react-native';
import { COLOR, FONT, SPACING, RADIUS, SHADOW } from '../../theme';

export default function HomeScreen() {
  // Dummy data for preview
  const nextAppointment = {
    exists: true,
    time: 'Today, 2:00 PM',
    doctor: 'Dr. Sinha',
    location: 'City Clinic'
  };
  return (
    <SafeAreaView style={s.container}>
      {/* Greeting Header */}
      <Text style={s.greeting}>Good morning, Alex</Text>

      {/* Next Appointment Card */}
      {nextAppointment.exists && (
        <View style={s.card}> 
          <Text style={s.cardLabel}>Next Appointment</Text>
          <Text style={s.timeText}>{nextAppointment.time}</Text>
          <Text style={s.detailText}>{nextAppointment.doctor}    {nextAppointment.location}</Text>
        </View>
      )}
      {/* Primary action */}
      <TouchableOpacity style={s.primaryBtn} activeOpacity={0.85}>
        <Text style={s.primaryBtnText}>Book Appointment</Text>
      </TouchableOpacity>
      {/* Quick access */}
      <View style={s.quickRow}>
        <TouchableOpacity style={s.quickItem} activeOpacity={0.8}>
          <Text style={s.quickText}>History</Text>
        </TouchableOpacity>
        <TouchableOpacity style={s.quickItem} activeOpacity={0.8}>
          <Text style={s.quickText}>Profile</Text>
        </TouchableOpacity>
      </View>
      <View style={{flex:1}}/>
      {/* Tab bar */}
      <View style={s.tabBar}>
        <Text style={[s.tabText, s.tabActive]}>Home</Text>
        <Text style={s.tabText}>History</Text>
        <Text style={s.tabText}>Profile</Text>
      </View>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLOR.background,
    padding: SPACING.l,
  },
  greeting: {
    fontFamily: FONT.medium,
    fontSize: 22,
    color: COLOR.text,
    marginBottom: SPACING.l,
  },
  card: {
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.xl,
    marginBottom: SPACING.l,
    ...SHADOW.card,
  },
  cardLabel: {
    fontFamily: FONT.bold,
    color: COLOR.primary,
    fontSize: 14,
    marginBottom: SPACING.s,
  },
  timeText: {
    fontFamily: FONT.medium,
    fontSize: 18,
    color: COLOR.text,
    marginBottom: SPACING.s,
  },
  detailText: {
    fontFamily: FONT.regular,
    fontSize: 15,
    color: COLOR.primary,
  },
  primaryBtn: {
    backgroundColor: COLOR.primary,
    borderRadius: RADIUS.md,
    paddingVertical: SPACING.m,
    alignItems: 'center',
    marginBottom: SPACING.m,
    ...SHADOW.button,
  },
  primaryBtnText: {
    color: COLOR.surface,
    fontFamily: FONT.bold,
    fontSize: 17,
    letterSpacing: 0.5,
  },
  quickRow: {
    flexDirection: 'row',
    gap: SPACING.m,
    marginBottom: SPACING.l,
  },
  quickItem: {
    flex: 1,
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.md,
    alignItems: 'center',
    padding: SPACING.m,
    ...SHADOW.card,
  },
  quickText: {
    color: COLOR.primary,
    fontFamily: FONT.medium,
    fontSize: 15,
  },
  tabBar: {
    flexDirection: 'row',
    backgroundColor: COLOR.surface,
    borderRadius: RADIUS.lg,
    padding: SPACING.m,
    marginBottom: SPACING.s,
    alignItems: 'center',
    justifyContent: 'space-between',
    ...SHADOW.card,
    height: 60,
  },
  tabText: {
    fontFamily: FONT.medium,
    color: COLOR.primary,
    fontSize: 15,
    paddingHorizontal: SPACING.l,
    opacity: 0.6,
  },
  tabActive: {
    opacity: 1,
    color: COLOR.text,
  }
});
