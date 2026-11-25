import { isRunningInExpoGo } from "expo";
import Constants from "expo-constants";
import * as Device from "expo-device";
import { useRouter, type Href } from "expo-router";
import { useEffect } from "react";
import { Platform } from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import * as Crypto from "expo-crypto";
import * as SecureStore from "expo-secure-store";
import { cancelarDispositivo, emitirAutorizacaoDeDispositivo, registrarDispositivo, revogarDispositivo } from "../client/account.ts";
import { supabase } from "../client/config.ts";
import { chaveDaAbertura, criarRegistroDeAberturas, destinoDaNotificacao } from "./notificacaoLink";
import { criarArmazenamentoDePush } from "./pushArmazenamento";
import { pushRemotoDisponivel } from "./pushRemoto";
import { criarVinculoDePush } from "./pushSessao";

const opcoesDoArmazenamento: SecureStore.SecureStoreOptions = { keychainAccessible: SecureStore.AFTER_FIRST_UNLOCK_THIS_DEVICE_ONLY };

const vinculo = criarVinculoDePush({
  api: { emitir: emitirAutorizacaoDeDispositivo, registrar: registrarDispositivo, cancelar: cancelarDispositivo, revogar: revogarDispositivo },
  armazenamento: criarArmazenamentoDePush({
    seguro: {
      disponivel: () => SecureStore.isAvailableAsync(),
      ler: (chave) => SecureStore.getItemAsync(chave, opcoesDoArmazenamento),
      gravar: (chave, valor) => SecureStore.setItemAsync(chave, valor, opcoesDoArmazenamento),
      apagar: (chave) => SecureStore.deleteItemAsync(chave, opcoesDoArmazenamento),
    },
    legado: { ler: (chave) => AsyncStorage.getItem(chave), apagar: (chave) => AsyncStorage.removeItem(chave) },
  }),
  contaAtual: async () => (await supabase().auth.getSession()).data.session?.user.id ?? null,
  gerarOperacao: () => Crypto.randomUUID(),
  gerarSegredo: () => Crypto.getRandomBytesAsync(32),
});
const primeiraAbertura = criarRegistroDeAberturas();

async function loadNotifications() {
  if (!pushRemotoDisponivel({ plataforma: Platform.OS, dispositivoFisico: Device.isDevice, expoGo: isRunningInExpoGo() })) return null;
  try {
    const Notifications = await import("expo-notifications");
    Notifications.setNotificationHandler({
      handleNotification: async () => ({ shouldShowBanner: true, shouldShowList: true, shouldPlaySound: true, shouldSetBadge: false }),
    });
    return Notifications;
  } catch {
    return null;
  }
}

async function pushToken(): Promise<string | null> {
  const projectId = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
  const Notifications = await loadNotifications();
  if (!projectId || !Notifications) return null;
  try {
    if (Platform.OS === "android") {
      await Notifications.setNotificationChannelAsync("default", { name: "Avisos da Muve", importance: Notifications.AndroidImportance.HIGH });
    }
    let { status } = await Notifications.getPermissionsAsync();
    if (status !== "granted") status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== "granted") return null;
    return (await Notifications.getExpoPushTokenAsync({ projectId })).data;
  } catch {
    return null;
  }
}

export function forgetPushToken(): Promise<void> {
  return vinculo.desvincular();
}

export function usePushNotifications(signedIn: boolean) {
  const router = useRouter();

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    void vinculo.vincular(pushToken, () => active);
    return () => {
      active = false;
    };
  }, [signedIn]);

  useEffect(() => {
    if (!signedIn) return;
    let active = true;
    let remove: (() => void) | null = null;
    void loadNotifications().then(async (Notifications) => {
      if (!Notifications || !active) return;
      const abrir = (response: Awaited<ReturnType<typeof Notifications.getLastNotificationResponseAsync>>) => {
        if (!active || !response || !primeiraAbertura(chaveDaAbertura(response))) return;
        const destino = destinoDaNotificacao(response.notification.request.content.data?.link);
        if (destino) router.push(destino as Href);
      };
      const subscription = Notifications.addNotificationResponseReceivedListener(abrir);
      remove = () => subscription.remove();
      const ultima = await Notifications.getLastNotificationResponseAsync().catch(() => null);
      if (!ultima || !active) return;
      abrir(ultima);
      await Notifications.clearLastNotificationResponseAsync().catch(() => {});
    });
    return () => {
      active = false;
      remove?.();
    };
  }, [signedIn, router]);
}
