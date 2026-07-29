import React from 'react';
import { SafeAreaView, ScrollView, StyleSheet, View } from 'react-native';
import { Card, Text, Button } from 'react-native-paper';
import { COLOR, SPACING, FONT, RADIUS, SHADOW } from '../../theme';

export default function PrescriptionDetailScreen({ route, navigation }: any) {
  const { prescription } = route.params;

  return (
    <SafeAreaView style={s.container}>
      <ScrollView contentContainerStyle={s.content}>
        <Card style={s.card}>
          <Card.Content>
            <Text style={s.title}>Prescription Details</Text>
            <Text style={s.meta}>Doctor: {prescription.doctor_name || 'N/A'}</Text>
            <Text style={s.meta}>Date: {prescription.prescribed_on ? new Date(prescription.prescribed_on).toLocaleString() : 'N/A'}</Text>
            
            <View style={s.divider} />
            
            <Text style={s.subTitle}>Medications:</Text>
            {prescription.items.map((item: any, index: number) => (
              <Text key={index} style={s.itemText}>• {item.medicine_name}</Text>
            ))}
          </Card.Content>
        </Card>
        <Button mode="contained" onPress={() => navigation.goBack()} style={s.button}>
          Go Back
        </Button>
      </ScrollView>
    </SafeAreaView>
  );
}

const createStyles = <T extends Record<string, unknown>>(styles: T): T => {
  return typeof StyleSheet.create === 'function' ? StyleSheet.create(styles) : styles;
};

const s = createStyles({
  container: { flex: 1, backgroundColor: COLOR.background },
  content: { padding: SPACING.l },
  card: { backgroundColor: COLOR.surface, borderRadius: RADIUS.lg, padding: SPACING.m, ...SHADOW.card },
  title: { color: COLOR.text, fontFamily: FONT.bold, fontSize: 20, marginBottom: SPACING.m },
  subTitle: { color: COLOR.text, fontFamily: FONT.medium, fontSize: 16, marginTop: SPACING.m, marginBottom: SPACING.s },
  meta: { color: COLOR.primary, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  divider: { height: 1, backgroundColor: COLOR.background, marginVertical: SPACING.m },
  itemText: { color: COLOR.text, fontFamily: FONT.regular, fontSize: 14, marginBottom: SPACING.xs },
  button: { marginTop: SPACING.l },
});
