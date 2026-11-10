import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, View } from 'react-native';
import { Card, Text, Button } from 'react-native-paper';
import { COLOR, SPACING, FONT, RADIUS, SHADOW } from '../../theme';

export default function PrescriptionDetailScreen({ route, navigation }: any) {
  const prescription = route?.params?.prescription ?? {};
  const items = Array.isArray(prescription.items) ? prescription.items : [];

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <Card style={s.card}>
          <Card.Content>
            <Text style={s.title}>Prescription Details</Text>
            <Text style={s.meta}>Doctor: {prescription.doctor_name || 'Clinic Doctor'}</Text>
            <Text style={s.meta}>Date: {prescription.prescribed_on ? new Date(prescription.prescribed_on).toLocaleString() : 'N/A'}</Text>
            {!!prescription.notes && (
              <Text style={s.notes}>Notes: {prescription.notes}</Text>
            )}

            <View style={s.divider} />

            <Text style={s.subTitle}>Medications:</Text>
            {items.length === 0 ? (
              <Text style={s.itemText}>No medications listed.</Text>
            ) : (
              items.map((item: any, index: number) => {
                const timing = [
                  item.dosage_morning ? 'Morning' : '',
                  item.dosage_afternoon ? 'Afternoon' : '',
                  item.dosage_evening ? 'Evening' : '',
                  item.dosage_night ? 'Night' : '',
                ]
                  .filter(Boolean)
                  .join(' · ');
                const food = item.before_food
                  ? 'Before food'
                  : item.after_food
                    ? 'After food'
                    : '';
                const detail = [
                  timing,
                  food,
                  item.quantity ? `Qty: ${item.quantity}` : '',
                  item.instructions || '',
                ]
                  .filter(Boolean)
                  .join(' • ');
                return (
                  <View key={item.id ?? index} style={s.itemBlock}>
                    <Text style={s.itemText}>• {item.medicine_name}</Text>
                    {!!detail && <Text style={s.itemMeta}>{detail}</Text>}
                  </View>
                );
              })
            )}
          </Card.Content>
        </Card>
        <Button mode="contained" onPress={() => navigation.goBack()} style={s.button}>
          Go Back
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: COLOR.background },
  content: { padding: SPACING.l },
  card: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.m, ...SHADOW.card },
  title: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 20, marginBottom: SPACING.m },
  subTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 16, marginTop: SPACING.m, marginBottom: SPACING.s },
  meta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  notes: { color: COLOR.text, fontFamily: FONT.regular, fontSize: 14, marginTop: SPACING.xs },
  divider: { height: 1, backgroundColor: COLOR.background, marginVertical: SPACING.m },
  itemBlock: { marginBottom: SPACING.s },
  itemText: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 14 },
  itemMeta: { color: COLOR.accent, fontFamily: FONT.regular, fontSize: 12, marginLeft: SPACING.m, marginTop: 2 },
  button: { marginTop: SPACING.l },
});
