import { redirect } from "next/navigation";

/** La competencia ahora vive junto a los precios, con una recomendación por producto. */
export default function CompetenciaPage() {
  redirect("/precios");
}
