-- Create a function to handle the trigger
CREATE OR REPLACE FUNCTION update_ultimo_nome()
RETURNS TRIGGER AS $$
BEGIN
    -- Se o pushName mudou e não é nulo, atualiza o Ultimo_nome
    IF NEW.pushName IS NOT NULL AND (OLD.pushName IS NULL OR NEW.pushName != OLD.pushName) THEN
        NEW."Ultimo_nome" = NEW.pushName;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create the trigger
DROP TRIGGER IF EXISTS update_contact_ultimo_nome ON "Contact";
CREATE TRIGGER update_contact_ultimo_nome
    BEFORE UPDATE ON "Contact"
    FOR EACH ROW
    EXECUTE FUNCTION update_ultimo_nome(); 