import { SafeAreaProvider } from "react-native-safe-area-context";
import { FactoryApp } from "./src/factory-app";

export default function App() {
  return (
    <SafeAreaProvider>
      <FactoryApp />
    </SafeAreaProvider>
  );
}
