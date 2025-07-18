-- Primeiro, remove o trigger e a função existentes
DROP TRIGGER IF EXISTS update_contact_ultimo_nome ON "Contact";
DROP FUNCTION IF EXISTS update_ultimo_nome();

-- Cria a nova função com um nome mais específico
CREATE OR REPLACE FUNCTION contact_update_ultimo_nome()
RETURNS TRIGGER AS $$
DECLARE
    updated_record RECORD;
BEGIN
    updated_record := NEW;
    -- Se o pushName mudou e não é nulo, atualiza o Ultimo_nome
    IF updated_record.pushName IS NOT NULL AND (OLD.pushName IS NULL OR updated_record.pushName != OLD.pushName) THEN
        updated_record."Ultimo_nome" := updated_record.pushName;
    END IF;
    RETURN updated_record;
END;
$$ LANGUAGE plpgsql;

-- Cria o novo trigger com um nome mais específico
CREATE TRIGGER contact_update_ultimo_nome_trigger
    BEFORE UPDATE ON "Contact"
    FOR EACH ROW
    EXECUTE FUNCTION contact_update_ultimo_nome(); 