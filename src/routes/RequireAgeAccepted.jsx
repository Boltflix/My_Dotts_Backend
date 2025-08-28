import { useEffect, useState } from "react";
import { Navigate, useLocation } from "react-router-dom";
import supabase from "@/lib/supabaseclient";
import { useAuth } from "@/contexts/AuthContext";

export default function RequireAgeAccepted({ children }) {
  const { user } = useAuth();
  const location = useLocation();
  const [loading, setLoading] = useState(true);
  const [ok, setOk] = useState(false);

  useEffect(() => {
    const run = async () => {
      if (!user) { setOk(false); setLoading(false); return; }
      const { data } = await supabase
        .from("profiles")
        .select("hasAcceptedTerms")
        .eq("id", user.id)
        .single();
      setOk(data?.hasAcceptedTerms === true);
      setLoading(false);
    };
    run();
  }, [user]);

  if (loading) return null;
  if (!user) return <Navigate to="/login" replace state={{ from: location }} />;
  if (!ok) return <Navigate to="/age-verification" replace state={{ from: location }} />;
  return children;
}
